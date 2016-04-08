// Copyright (c) 2015 Uber Technologies, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.
'use strict';


var Member = require('../lib/membership/member');
var safeParse = require('../lib/util').safeParse;


function MiddlewareStack(middlewares) {
    this.middlewares = middlewares || [];
}

// XXX: adding nextTick to avoid blowing the call stack breaks a test
MiddlewareStack.prototype.run = function run(req, arg2, arg3, handler, callback) {
    var self = this;

    var i = -1;
    callRequestMiddleware(arg2, arg3);

    function callRequestMiddleware(arg2, arg3) {
        i += 1;
        if (i < self.middlewares.length) {
            var next = self.middlewares[i].request;
            if (typeof next === 'function') {
                next(req, arg2, arg3, callRequestMiddleware);
            } else {
                // skip this middleware if it doesn't implement request
                callRequestMiddleware(arg2, arg3);
            }
        } else {
            handler(req, arg2, arg3, callResponseMiddleware);
        }
    }
    function callResponseMiddleware(err, res1, res2) {
        i -= 1;
        if (i >= 0) {
            var next = self.middlewares[i].response;
            if (typeof next === 'function') {
                next(req, err, res1, res2, callResponseMiddleware);
            } else {
                // skip this middleware if it doesn't implement response
                callResponseMiddleware(err, res1, res2);
            }
        } else {
            callback(req, err, res1, res2)
        }
    }
}


function faultyAsTombstone(change) {
    if(change.status === Member.Status.faulty && change.tombstone) {
        change.status = Member.Status.tombstone;
        delete change['tombstone'];
        return true;
    }
    return false;
}

function tombstoneAsFaulty(change) {
    if(change.status === Member.Status.tombstone) {
        change.status = Member.Status.faulty;
        change.tombstone = true;
        return true;
    }
    return false;
}


var tombstonePatchServerMiddleware = {
    'request': function(req, arg2, arg3, callback) {
        var changes = [];
        var changed = false;
        if (req.endpoint === '/protocol/ping') {
            var arg3_parsed = safeParse(arg3);
            if (arg3_parsed !== null && arg3_parsed['changes']) {
                changes = arg3_parsed['changes'];
            }
        }
        changes.forEach(function(change) {
            changed = changed || faultyAsTombstone(change);
        });
        if (changed) {
            arg3 = JSON.stringify(arg3_parsed);
        }
        callback(arg2, arg3);
    },
    'response': function(req, err, res1, res2, callback) {
        var changes = []
        var changed = false;
        if (req.endpoint == '/protocol/ping') {
            var res2_parsed = safeParse(res2);
            if (res2_parsed !== null && res2_parsed['changes']) {
                changes = res2_parsed['changes'];
            }
        }
        if (req.endpoint == '/protocol/join') {
            var res2_parsed = safeParse(res2);
            if (res2_parsed !== null && res2_parsed['membership']) {
                changes = res2_parsed['membership'];
            }
        }
        changes.forEach(function(change) {
            changed = changed || tombstoneAsFaulty(change);
        });
        if (changed) {
            res2 = JSON.stringify(res2_parsed);
        }
        callback(err, res1, res2);
    }
};

// The client middleware is like the server middleware but reversed: everytime
// we make a request, change any  tombstone to a flagged faulty; on response
// patch replace any flagged faulty with a tombstone.
var tombstonePatchClientMiddleware = {
    'request': function(req, arg2, arg3, callback) {
        if (req.endpoint === '/protocol/ping') {
            if (arg3 && arg3['changes']) {
                arg3['changes'].forEach(tombstoneAsFaulty);
            }
        }
        callback(arg2, arg3);
    },
    'response': function(req, err, res1, res2, callback) {
        if (req.endpoint === '/protocol/ping') {
            if (res1 && res1['changes']) {
                res1['changes'].forEach(faultyAsTombstone);
            }
        }
        if (req.endpoint == '/protocol/join') {
            if (res1 && res1['membership']) {
                res1['membership'].forEach(faultyAsTombstone);
            }
        }
        callback(err, res1, res2);
    }
};


module.exports = {
    'MiddlewareStack': MiddlewareStack,
    'tombstonePatchServerMiddleware': tombstonePatchServerMiddleware,
    'tombstonePatchClientMiddleware': tombstonePatchClientMiddleware
};
