// Load modules

var Stream = require('stream');
var Zlib = require('zlib');
var Boom = require('boom');
var Shot = require('shot');
var Plain = require('./plain');
var Payload = require('./payload');
var Headers = require('./headers');
var Hoek = require('hoek');


// Declare internals

var internals = {};


exports.Plain = Plain;
exports.Payload = Payload;


exports.wrap = function (result, request) {

    var response = (result instanceof Error ? Boom.wrap(result)
                                            : (result instanceof Plain ? result : new Plain(result, request)));
    return response;
};


exports.send = function (request, callback) {

    var response = request.response;
    if (response.isBoom) {
        return internals.fail(request, response, callback);
    }

    if (request.method === 'get' ||
        request.method === 'head') {

        // Not all headers are setup at this point - 'etag' and 'last-modified' must be set before _marshall()

        if (response.headers.etag &&
            request.headers['if-none-match'] === response.headers.etag) {

            response.statusCode = 304;
        }
        else {
            var ifModifiedSinceHeader = request.headers['if-modified-since'];
            var lastModifiedHeader = response.headers['last-modified'];

            if (ifModifiedSinceHeader &&
                lastModifiedHeader) {

                var ifModifiedSince = Date.parse(ifModifiedSinceHeader);
                var lastModified = Date.parse(lastModifiedHeader);

                if (ifModifiedSince &&
                    lastModified &&
                    ifModifiedSince >= lastModified) {

                    response.statusCode = 304;
                }
            }
        }
    }

    internals.marshall(request, function (err) {

        if (err) {
            request._setResponse(err);
            return internals.fail(request, err, callback);
        }

        return internals.transmit(response, request, callback);
    });
};


internals.marshall = function (request, next) {

    var response = request.response;
    if (request.method === 'head' ||
        response.statusCode === 304) {

        // Close unused file streams

        response._close();

        // Set empty stream

        response._payload = new internals.Empty();
        delete response.headers['content-length'];

        if (response.statusCode === 304) {
            delete response.headers.etag;
            delete response.headers['last-modified'];
        }

        return internals.headers(request, next);
    }

    response._marshall(request, function (err) {

        if (err) {
            return next(err.isBoom ? err : Boom.wrap(err));
        }

        return internals.headers(request, next);
    });
};


internals.headers = function (request, next) {

    var response = request.response;

    if (request.jsonp &&
        response._payload.jsonp) {

        response.type('text/javascript');
        response._payload.jsonp(request.jsonp);
    }

    Headers.apply(request, function (err) {

        if (err) {
            return next(err);
        }

        // Apply pass through headers

        if (response._payload.headers &&
            response.settings.passThrough) {

            var localCookies = Hoek.clone(response.headers['set-cookie']);
            var localHeaders = response.headers;
            response.headers = Hoek.clone(response._payload.headers);
            Hoek.merge(response.headers, localHeaders);

            if (localCookies) {
                var headerKeys = Object.keys(response._payload.headers);
                for (var i = 0, il = headerKeys.length; i < il; ++i) {
                    if (headerKeys[i].toLowerCase() === 'set-cookie') {
                        delete response.headers[headerKeys[i]];
                        response._header('set-cookie', [].concat(response._payload.headers[headerKeys[i]]).concat(localCookies));
                        break;
                    }
                }
            }
        }

        return next();
    });
};


internals.fail = function (request, boom, callback) {

    var error = boom.output;
    var response = new Plain(error.payload, request);
    response.code(error.statusCode);
    Hoek.merge(response.headers, error.headers);
    request.response = response;                            // Not using request._setResponse() to avoid double log

    internals.marshall(request, function (/* err */) {

        // Return the original error (which is partially prepared) instead of having to prepare the result error
        return internals.transmit(response, request, callback);
    });
};


internals.transmit = function (response, request, callback) {

    // Injection

    if (response.variety === 'plain' &&
        Shot.isInjection(request.raw.req)) {

        request.raw.res._hapi = { result: response.source };
    }

    // Setup source

    var source = response._payload;
    var encoder = null;

    // Content encoding

    if (!response.headers['content-encoding'] &&
        (!source._hapi || !source._hapi.isEmpty)) {

        var encoding = request.info.preferredEncoding;
        if (encoding === 'deflate' || encoding === 'gzip') {
            var keys = Object.keys(response.headers);
            for (var i = 0, il = keys.length; i < il; ++i) {
                var key = keys[i];
                if (/content\-length/i.test(key)) {                 // Can be lowercase when coming from proxy
                    delete response.headers[key];
                }
            }

            response._header('content-encoding', encoding);
            response.vary('accept-encoding');
            encoder = (encoding === 'gzip' ? Zlib.createGzip() : Zlib.createDeflate());
        }
    }

    // Write headers

    var headers = Object.keys(response.headers);
    for (var h = 0, hl = headers.length; h < hl; ++h) {
        var header = headers[h];
        request.raw.res.setHeader(header, response.headers[header]);
    }

    request.raw.res.writeHead(response.statusCode);

    // Generate tap stream

    var tap = response._tap();

    // Write payload

    var hasEnded = false;
    var end = function (err, event) {

        if (!hasEnded) {
            hasEnded = true;

            if (event !== 'aborted') {
                request.raw.res.end();
            }

            source.removeListener('error', end);

            request.raw.req.removeListener('aborted', onAborted);
            request.raw.req.removeListener('close', onClose);

            request.raw.res.removeListener('close', onClose);
            request.raw.res.removeListener('error', end);
            request.raw.res.removeListener('finish', end);

            var tags = (err ? ['hapi', 'response', 'error']
                            : (event ? ['hapi', 'response', 'error', event]
                                     : ['hapi', 'response']));

            if (event || err) {
                request.emit('disconnect');
            }

            request.log(tags, err);
            callback();
        }
    };

    source.once('error', end);

    var onAborted = function () {

        end(null, 'aborted');
    };

    var onClose = function () {

        end(null, 'close');
    };

    request.raw.req.once('aborted', onAborted);
    request.raw.req.once('close', onClose);

    request.raw.res.once('close', onClose);
    request.raw.res.once('error', end);
    request.raw.res.once('finish', end);

    var preview = (tap ? source.pipe(tap) : source);
    var encoded = (encoder ? preview.pipe(encoder) : preview);
    encoded.pipe(request.raw.res);
};


internals.Empty = function () {

    Stream.Readable.call(this);

    this._hapi = { isEmpty: true };
};

Hoek.inherits(internals.Empty, Stream.Readable);


internals.Empty.prototype._read = function (/* size */) {

    this.push(null);
};
