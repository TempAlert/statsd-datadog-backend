/*jshint node:true, laxcomma:true */

/*
 * Flush stats to datadog (http://datadoghq.com/).
 *
 * To enable this backend, include 'statsd-datadog-backend' in the backends
 * configuration array:
 *
 *   backends: ['statsd-datadog-backend']
 *
 * This backend supports the following config options:
 *
 *   datadog.apiKey: Your DataDog API key
 *   datadog.prefix: A global prefix for all metrics
 *   datadog.tags: A global set of tags for all metrics
 *   datadog.skipInternalMetrics: Don't report statsd metrics
 */

var net = require('net'),
    os = require('os'),
    request = require('request'),
    util = require('util');

var logger;
var debug;
var flushInterval;
var hostname;
var datadogApiHost;
var datadogApiKey;
var datadogStats = {};
var datadogPrefix;
var datadogTags;

// Do we skip publishing internal statsd metrics.
var skipInternalMetrics = true;
var internalStatsdRe = /^statsd\./;

var Datadog = function(api_key, options) {
    options = options || {};
    this.api_key = api_key;
    this.api_host = options.api_host || 'https://app.datadoghq.com';
    this.host_name = options.host_name || os.hostname();
    this.pending_requests = 0;
};

Datadog.prototype.metrics = function(payload) {
    var client = this;
    var message = {
        series: payload
    };
    util.log('DEBUG: datadog-backend: ' +  JSON.stringify(message));
    client._post('series', message);
};

Datadog.prototype._post = function(controller, message) {
    var client = this;
    var body = JSON.stringify(message);

    if (this.api_host.indexOf('https') == -1) {
        util.log('WARN: datadog-backend: You are about to send unencrypted metrics.');
    }
    client.pending_requests += 1;
    request.post({
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': body.length
        },
        url: this.api_host + '/api/v1/' + controller + '?api_key=' + client.api_key,
        body: body
    }, function(error) {
        if (error) {
            util.log('ERROR: Skipping, cannot send data to Datadog: ' + error.message);
        }
        client.pending_requests -= 1;
    });
};

var post_stats = function datadog_post_stats(payload) {
   try {
       if(payload != null && payload.length > 0){
          new Datadog(datadogApiKey, { api_host: datadogApiHost }).metrics(payload);
          datadogStats.last_flush = Math.round(new Date().getTime() / 1000);
       }
       if (debug) {
          util.log('WARN: Skipping payload. It was either null or had no data');
       }
   } catch(e){
      if (debug) {
         util.log('ERROR: Skipping, cannot send data to Datadog: ' + e);
      }
      datadogStats.last_exception = Math.round(new Date().getTime() / 1000);
   }
};

var flush_stats = function datadog_post_stats(ts, metrics) {
   var counters = metrics.counters;
   var gauges = metrics.gauges;
   var timers = metrics.timers;
   var pctThreshold = metrics.pctThreshold;

   var payload = [];
   var value;

   var key;
   if (debug) {
      util.log('DEBUG:['+ts+']:raw metrics: ' + JSON.stringify(metrics));
   }
   // Send counters
   for (key in counters) {
      if (skipInternalMetrics && key.match(internalStatsdRe) != null) {
        continue;
      }
      value = counters[key];
      var valuePerSecond = value / (flushInterval / 1000); // calculate 'per second' rate
      metricKey = get_tagged_metric_key(key);
      metricKey = get_prefix(metricKey);
      counterHost = get_host_from_metric(key);
      metricTags = get_tagged_metric_tags(key);

      payload.push({
         metric: metricKey,
         points: [[ts, valuePerSecond]],
         type: 'gauge',
         host: counterHost,
         tags: metricTags
      });
   }

   // Send gauges
   for (key in gauges) {
      if (skipInternalMetrics && key.match(internalStatsdRe) != null) {
        continue;
      }
      value = gauges[key];

      metricKey = get_tagged_metric_key(key);
      metricKey = get_prefix(metricKey);
      guageHost = get_host_from_metric(key);
      metricTags = get_tagged_metric_tags(key);

      payload.push({
         metric: metricKey,
         points: [[ts, value]],
         type: 'gauge',
         host: guageHost,
         tags: metricTags
      });
   }

   // Compute timers and send
   for (key in timers) {
      if (skipInternalMetrics && key.match(internalStatsdRe) != null) {
        continue;
      }
      if (timers[key].length > 0) {
         var values = timers[key].sort(function (a,b) { return a-b; });
         var count = values.length;
         var min = values[0];
         var max = values[count - 1];

         var mean = min;
         var maxAtThreshold = max;
         var i;

         if (count > 1) {
            var thresholdIndex = Math.round(((100 - pctThreshold) / 100) * count);
            var numInThreshold = count - thresholdIndex;
            var pctValues = values.slice(0, numInThreshold);
            maxAtThreshold = pctValues[numInThreshold - 1];

            // average the remaining timings
            var sum = 0;
            for (i = 0; i < numInThreshold; i++) {
               sum += pctValues[i];
            }

            mean = sum / numInThreshold;
         }

         // metricKey will be the sanitized version of the key
         metricKey = get_tagged_metric_key(key);
         metricKey = get_prefix(metricKey);
         timerHost = get_host_from_metric(key);
         metricTags = get_tagged_metric_tags(key);

         payload.push({
            metric: metricKey + '.mean',
            points: [[ts, mean]],
            type: 'gauge',
            host: timerHost,
            tags: metricTags
         });

         payload.push({
            metric: metricKey + '.upper',
            points: [[ts, max]],
            type: 'gauge',
            host: timerHost,
            tags: metricTags
         });

         payload.push({
            metric: metricKey + '.upper_' + pctThreshold,
            points: [[ts, maxAtThreshold]],
            type: 'gauge',
            host: timerHost,
            tags: metricTags
         });

         payload.push({
            metric: metricKey + '.lower',
            points: [[ts, min]],
            type: 'gauge',
            host: timerHost,
            tags: metricTags
         });

         payload.push({
            metric: metricKey + '.count',
            points: [[ts, count]],
            type: 'gauge',
            host: timerHost,
            tags: metricTags
         });
      }
   }

   post_stats(payload);
};
var get_host_from_metric = function datadog_get_host_from_metric(key) {
    // example of what we are parsing
    // devcore.core.broadcaster.device-data-timing#host=DEV-UDP-01.upper
    var hashLocation = key.indexOf('#');
    // -1 is not found
    if (hashLocation > -1){
        var keyTags = key.substring(hashLocation+1, key.length);
        var keyTagPairs = keyTags.split(',');
        for (var i = 0, len = keyTagPairs.length; i < len; i++) {
            var ktp = keyTagPairs[i];
            if(ktp[0].toLowerCase() == "host"){
                if(logAll){
                  util.log('DEBUG: Found host tag: ' + ktp[1]);
                }
                return ktp[1];
            }
        }
    }
    // if we didn't find a host name or there were not any tags sent in
    // just return whatever we think the hostname is
    return hostname;
}

var get_tagged_metric_tags = function datadog_get_tagged_metric_tags(key) {
    // datadog takes tagged metrics in the following format...
    // https://docs.datadoghq.com/developers/dogstatsd/#metrics-1
    // metric.name:value|type|@sample_rate|#tag1:value,tag2
    // example of what we are parsing
    // devcore.core.broadcaster.device-data-timing#host=DEV-UDP-01
    var hashLocation = key.indexOf('#');
    // -1 is not found
    if (hashLocation  == -1){
        if(logAll){
          util.log('DEBUG: Metric was not tagged. Returning datadogTags: ' + datadogTags);
        }
        return datadogTags;
    }
    // get just the stuff after the #
    var metricTagString = key.substring(hashLocation+1, key.length);
    // append the datadog tags if they are set
    if (datadogTags){
        metricTagString = metricTagString + ',' + datadogTags;
    }
    // replace (globally) any '=' with ':'
    metricTagString = metricTagString.replace(/=/g,':').split(',');
    if(logAll){
      util.log('DEBUG: Metric tag string: ' + metricTagString);
    }
    return metricTagString;
}

var get_tagged_metric_key = function datadog_get_tagged_metric_key(key) {
     // example of what we are parsing
    // devcore.core.broadcaster.device-data-timing#host=DEV-UDP-01
    var hashLocation = key.indexOf('#');
    // -1 is not found
    if (hashLocation  == -1){
        if(logAll){
          util.log('DEBUG: Metric was not tagged: ' + key);
        }
        return key;
    }
    var keyWithNoTags =  key.substring(0, hashLocation);
    if(logAll){
      util.log('DEBUG: Metric was tagged. Key with no tags is: ' + keyWithNoTags + ' original key: ' + key);
    }
    // return everything before the #
    return keyWithNoTags;
}

var get_prefix = function datadog_get_prefix(key) {
    if (datadogPrefix !== undefined) {
        return [datadogPrefix, key].join('.');
    } else {
        return key;
    }
}

var backend_status = function datadog_status(writeCb) {
   var stat;
   for (stat in datadogStats) {
      writeCb(null, 'datadog', stat, datadogStats[stat]);
   }
};

exports.init = function datadog_init(startup_time, config, events, log) {
   logAll = debug = config.debug;
   if (typeof logger !== 'undefined') {
       util = logger;
   }
   util.log('INFO: Loading datadog backend...');
   hostname = config.hostname || os.hostname();
   if (config.datadog) {
        datadogApiKey = config.datadog.apiKey;
        datadogApiHost = config.datadog.apiHost;
        datadogPrefix = config.datadog.prefix;
        datadogTags = config.datadog.tags;

        if (config.datadog.skipInternalMetrics != null) {
          skipInternalMetrics = config.datadog.skipInternalMetrics;
        }

        if (datadogTags === undefined || datadogTags.constructor !== Array || datadogTags.length < 1) {
            datadogTags = [];
        }

        if (!datadogApiHost) {
            datadogApiHost = 'https://app.datadoghq.com';
        }

        datadogStats.last_flush = startup_time;
        datadogStats.last_exception = startup_time;

        flushInterval = config.flushInterval;
   }

   if(!datadogApiKey) {
    util.log('ERROR: Invalid configuration for DataDog backend. No API Key.');
    return false;
   }
   events.on('flush', flush_stats);
   events.on('status', backend_status);

   return true;
};
