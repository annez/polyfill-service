var polyfillio = require('../lib');
var express = require('express');
var app = express().enable("strict routing");
var origamijson = require('../origami.json');
var PolyfillSet = require('./PolyfillSet');
var path = require('path');
var metrics = require('./metrics');
var testing = require('./testing');
var docs = require('./docs');
var appVersion = require('../package.json').version;

'use strict';

metrics.gauge('memory', function() {
	return process.memoryUsage().rss;
});

var one_day = 60 * 60 * 24;
var one_week = one_day * 7;
var one_year = one_day * 365;
var contentTypes = {".js": 'application/javascript', ".css": 'text/css'};


// Default cache control policy
app.use(function(req, res, next) {
	res.set('Cache-Control', 'public, max-age='+one_week+', stale-while-revalidate='+one_week+', stale-if-error='+one_week);
	res.set('Timing-Allow-Origin', '*');
	res.removeHeader("x-powered-by");
	return next();
});


/* Tests */

app.use('/test/libs/mocha', express.static(path.join(__dirname, '/../node_modules/mocha')));
app.use('/test/libs/expect', express.static(path.join(__dirname, '/../node_modules/expect.js/')));

app.get(/\/test\/director\/?$/, testing.createEndpoint('director', polyfillio));
app.get(/\/test\/tests\/?$/, testing.createEndpoint('runner', polyfillio));

/* Documentation and version routing */

app.get(/^\/(?:v([12])(?:\/(?:docs\/?(?:([^\/]+)\/?)?)?)?)?$/, docs.route);
app.use(/^\/v[12]\/docs\/assets/, express.static(__dirname + '/../docs/assets'));



/* Endpoints for health, application metadata and availability status
 * compliant with FT Origami standard
 * http://origami.ft.com/docs/syntax/web-service-index/ */

// Describe the available API versions
app.get(/^\/__about$/, function(req, res) {
	var info = {
		"name": "polyfill-service",
		"versions": [
			"/v1/",
			"/v2/"
		]
	};
	res.set("Content-Type", "application/json;charset=utf-8");
	res.send(JSON.stringify(info));
});

// Describe the active API version
app.get(/^\/v([12])\/__about$/, function(req, res) {
	var info = {
		"name": "polyfill-service",
		"apiVersion": req.params[0],
		"appVersion": appVersion,
		"dateCreated": '2014-07-14T10:28:45Z',
		"support": origamijson.support,
		"supportStatus": (parseInt(req.params[0], 10) === 2) ? "active" : "deprecated"
	};

	res.set("Content-Type", "application/json;charset=utf-8");
	res.send(JSON.stringify(info));
});

// "Good to go" endpoint
app.get(/^\/__gtg$/, function(req, res) {
	res.set("Content-Type", "text/plain;charset=utf-8");
	res.set("Cache-Control", "no-cache");
	res.send("OK");
});

// Healthcheck
app.get(/^\/__health$/, function(req, res) {
    var info = {
        "schemaVersion": 1,
        "name": "polyfill-service",
        "description": "Open API endpoint for retrieving Javascript polyfill libraries based on the user's user agent.  More at http://github.com/Financial-Times/polyfill-service.",
        "checks": [
            {
                "name": "Server is up",
                "ok": true,
                "severity": 2,
                "businessImpact": "Web page rendering may degrade for customers using certain browsers. Dynamic client side behaviour is likely to fail.",
                "technicalSummary": "Tests that the Node JS process is up.",
                "panicGuide": "This application consists of Node JS processes on any number of nodes in an environment.  The process must have read permissions on files within its deployment.",
                "checkOutput": "None",
                "lastUpdated": new Date().toISOString()
            }
        ],
    };

    res.set('Cache-Control', 'no-cache');
    res.set('Content-Type', 'application/json;charset=utf-8');
    res.send(JSON.stringify(info));
});


/* API endpoints */

app.get(/^\/v([12])\/polyfill(\.\w+)(\.\w+)?/, function(req, res) {
	metrics.meter('hits').mark();
	var respTimeTimer = metrics.timer('respTime').start();

	var apiVersion = parseInt(req.params[0], 10);
	var firstParameter = req.params[1].toLowerCase();
	var minified =  firstParameter === '.min';
	var fileExtension = minified ? req.params[2].toLowerCase() : firstParameter;
	var uaString = req.query.ua || req.header('user-agent');
	var flags = req.query.flags ? req.query.flags.split(',') : [];
	var warnings = [];

	if (apiVersion === 1) {
		warnings.push('API Version 1 is deprecated: please consider upgrading to v2.  API v1 will be closed after December 31, 2015, at which time v1 requests will be mapped internally to v2 requests and will be subject to potentially breaking changes.  See https://cdn.polyfill.io/v2/docs/api for details.');
	}

	// Backwards compatibility
	if (req.query.gated && apiVersion < 2) {
		flags.push('gated');
		warnings.push('The `gated` query parameter is deprecated and is not supported in API v2.  Set `flags=gated` instead.');
	}

	// Currently don't support CSS
	if (fileExtension !== '.js') {
		res.status(404);
		res.set('Content-Type', 'text/plain;charset=utf-8');
		res.send('/* Type not supported.  Only .js is supported at the moment */');
		return;
	}

	var polyfills = PolyfillSet.fromQueryParam(req.query.features || 'default', flags);

	// If inbound request did not specify UA on the query string, the cache key must use the HTTP header
	if (!req.query.ua) {
		res.set('Vary', 'User-Agent');
	}

	var params = {
		features: polyfills.get(),
		minify: minified
	};
	if (req.query.libVersion && apiVersion === 1) {
		warnings.push('The `libVersion` query parameter is deprecated and switching library version at runtime is not supported in API v2.  To use an older version of the polyfill library, consider running your own version of the service at the version that you want.');
		params.libVersion = req.query.libVersion;
	}
	if (req.query.unknown) {
		params.unknown = req.query.unknown;
	}
	if (uaString) {
		params.uaString = uaString;
		metrics.counter('useragentcount.'+polyfillio.normalizeUserAgent(uaString).replace(/^(.*?)\/(\d+)(\..*)?$/, '$1.$2')).inc();
	}

	polyfillio.getPolyfillString(params).then(function(op) {
		if (warnings.length) {
			op = '/* WARNINGS:\n\n- ' + warnings.join('\n- ') + '\n\n*/\n\n' + op;
		}
		if (req.query.callback && req.query.callback.match(/^[\w\.]+$/)) {
			op += "\ntypeof "+req.query.callback+"==='function' && "+req.query.callback+"();";
		}
		res.set('Content-Type', contentTypes[fileExtension]+';charset=utf-8');
		res.set('Access-Control-Allow-Origin', '*');
		res.send(op);
		respTimeTimer.end();
	});

});

app.get("/v[12]/normalizeUa", function(req, res, next) {

	if (req.query.ua) {
		res.status(200);
		res.set('Cache-Control', 'public, max-age='+one_year+', stale-if-error='+(one_year+one_week));
		res.set('Normalized-User-Agent', encodeURIComponent(polyfillio.normalizeUserAgent(req.query.ua)));
		res.send();
	} else {
		res.status(400);
		res.send('ua query param required');
	}
});

function startService(port, callback) {
	callback = callback || function() {};

	app
		.listen(port, function (err) {
			callback(err, app);
		})
		.on('error', function (err) {
			callback(err);
		});
}

module.exports = startService;
