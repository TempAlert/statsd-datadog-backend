# statsd-datadog-backend

A plugin to connect etsy's statsD to Datadog

## Installation

```sh
cd /path/to/statsd-dir
npm install statsd-datadog-backend
```

## Configuration

```js
datadog.apiKey: "your_api_key" // You can get it from this page: https://app.datadoghq.com/account/settings#api
datadog.prefix: "your_prefix" // Your metrics will be prefixed by this prefix
datadog.tags: ["your:tag", "another:tag"]  // Your metrics will include these tags
datadog.skipInternalMetrics: "true/false" //Don't report statsd metrics
```

## How to enable

Add statsd-datadog-backend to your list of statsd backends:

```js
backends: ["statsd-datadog-backend"]
```
