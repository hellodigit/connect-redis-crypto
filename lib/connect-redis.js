/*!
 * Connect - Redis
 * Copyright(c) 2012 TJ Holowaychuk <tj@vision-media.ca>
 * MIT Licensed
 */

/**
 * Module dependencies.
 */

var debug = require('debug')('connect:redis');
var crypto = require('crypto');
var debug = require('debug')('connect:redis');
var redis = require('redis');
var default_port = 6379;
var default_host = '127.0.0.1';
var noop = function(){};

/**
 * One day in seconds.
 */

var oneDay = 86400;

function getTTL(store, sess) {
  var maxAge = sess.cookie.maxAge;
  return store.ttl || (typeof maxAge === 'number'
    ? maxAge / 1000 | 0
    : oneDay);
}

/**
 * Return the `RedisStore` extending `express`'s session Store.
 *
 * @param {object} express session
 * @return {Function}
 * @api public
 */

module.exports = function (session) {

  /**
   * Express's session Store.
   */

  var Store = session.Store;

  /**
   * Initialize RedisStore with the given `options`.
   *
   * @param {Object} options
   * @api public
   */

  function RedisStore (options) {
    var self = this;

    options = options || {};
    Store.call(this, options);
    this.prefix = options.prefix == null
      ? 'sess:'
      : options.prefix;

    /* istanbul ignore next */
    if (options.url) {
      console.error('Warning: "url" param is deprecated and will be removed in a later release: use redis-url module instead');
      var url = require('url').parse(options.url);
      if (url.protocol === 'redis:') {
        if (url.auth) {
          var userparts = url.auth.split(':');
          options.user = userparts[0];
          if (userparts.length === 2) {
            options.pass = userparts[1];
          }
        }
        options.host = url.hostname;
        options.port = url.port;
        if (url.pathname) {
          options.db = url.pathname.replace('/', '', 1);
        }
      }
    }

    // convert to redis connect params
    if (options.client) {
      this.client = options.client;
    }
    else if (options.socket) {
      this.client = redis.createClient(options.socket, options);
    }
    else if (options.port || options.host) {
      this.client = redis.createClient(
        options.port || default_port,
        options.host || default_host,
        options
      );
    }
    else {
      this.client = redis.createClient(options);
    }

    if (options.pass) {
      this.client.auth(options.pass, function (err) {
        if (err) {
          throw err;
        }
      });
    }

    this.ttl = options.ttl;
    this.disableTTL = options.disableTTL;

    this.secret = options.secret || false;
    this.algorithm = options.algorithm || false;

    if (options.unref) this.client.unref();

    if ('db' in options) {
      if (typeof options.db !== 'number') {
        console.error('Warning: connect-redis expects a number for the "db" option');
      }

      self.client.select(options.db);
      self.client.on('connect', function () {
        self.client.send_anyways = true;
        self.client.select(options.db);
        self.client.send_anyways = false;
      });
    }

    self.client.on('error', function (er) {
      self.emit('disconnect', er);
    });

    self.client.on('connect', function () {
      self.emit('connect');
    });
  }

  /**
   * Wrapper to create cipher text, digest & encoded payload
   *
   * @param {String} payload
   * @api private
   */

  function encryptData(plaintext){
    var pt = encrypt(this.secret, plaintext, this.algo)
      , hmac = digest(this.secret, pt)

    return {
      ct: pt,
      mac: hmac
    };
  }

  /**
   * Wrapper to extract digest, verify digest & decrypt cipher text
   *
   * @param {String} payload
   * @api private
   */

  function decryptData(ciphertext){
    ciphertext = JSON.parse(ciphertext)
    var hmac = digest(this.secret, ciphertext.ct);

    if (hmac != ciphertext.mac) {
      throw 'Encrypted session was tampered with!';
    }

    return decrypt(this.secret, ciphertext.ct, this.algo);
  }

    /**
   * Generates HMAC as digest of cipher text
   *
   * @param {String} key
   * @param {String} obj
   * @param {String} algo
   * @api private
   */

  function digest(key, obj) {
    var hmac = crypto.createHmac('sha1', key);
    hmac.setEncoding('hex');
    hmac.write(obj);
    hmac.end();
    return hmac.read();
  }

  /**
   * Creates cipher text from plain text
   *
   * @param {String} key
   * @param {String} pt
   * @param {String} algo
   * @api private
   */

  function encrypt(key, pt, algo) {
    var text = JSON.stringify(pt);
    var textBuffer = new Buffer(text, 'utf8');
    var cipher = crypto.createCipher('aes-256-ecb', key);
    cipher.write(textBuffer);
    cipher.end();
    return cipher.read().toString('hex');
  }

  /**
   * Creates plain text from cipher text
   *
   * @param {String} key
   * @param {String} pt
   * @param {String} algo
   * @api private
   */

  function decrypt(key, ct, algo) {
    var hexBuffer = new Buffer(ct, 'hex');
    var decipher = crypto.createDecipher('aes-256-ecb', key);
    decipher.write(hexBuffer);
    decipher.end();
    var data = decipher.read().toString('utf8');
    return JSON.parse(data);
  }

  /**
   * Inherit from `Store`.
   */

  RedisStore.prototype.__proto__ = Store.prototype;

  /**
   * Attempt to fetch session by the given `sid`.
   *
   * @param {String} sid
   * @param {Function} fn
   * @api public
   */

  RedisStore.prototype.get = function (sid, fn) {
    var store = this;
    var psid = store.prefix + sid;
    if (!fn) fn = noop;
    debug('GET "%s"', sid);
    var secret = this.secret || false;

    store.client.get(psid, function (er, data) {
      if (er) return fn(er);
      if (!data) return fn();

      var result;
      data = (secret) ? decryptData.call(store, data) : data.toString();
      debug('GOT %s', data);

      try {
        result = JSON.parse(data);
      }
      catch (er) {
        return fn(er);
      }
      return fn(null, result);
    });
  };

  /**
   * Commit the given `sess` object associated with the given `sid`.
   *
   * @param {String} sid
   * @param {Session} sess
   * @param {Function} fn
   * @api public
   */

  RedisStore.prototype.set = function (sid, sess, fn) {
    var store = this;
    var psid = store.prefix + sid;
    if (!fn) fn = noop;

    try {
      var jsess = JSON.stringify(
        (this.secret)
        ? encryptData.call(this, JSON.stringify(sess), this.secret, this.algorithm)
        : sess);
    }
    catch (er) {
      return fn(er);
    }

    if (store.disableTTL) {
      debug('SET "%s" %s', sid, jsess);
      store.client.set(psid, jsess, function (er) {
        if (er) return fn(er);
        debug('SET complete');
        fn.apply(null, arguments);
      });
      return;
    }

    var ttl = getTTL(store, sess);

    debug('SETEX "%s" ttl:%s %s', sid, ttl, jsess);
    store.client.setex(psid, ttl, jsess, function (er) {
      if (er) return fn(er);
      debug('SETEX complete');
      fn.apply(this, arguments);
    });
  };

  /**
   * Destroy the session associated with the given `sid`.
   *
   * @param {String} sid
   * @api public
   */

  RedisStore.prototype.destroy = function (sid, fn) {
    sid = this.prefix + sid;
    debug('DEL "%s"', sid);
    this.client.del(sid, fn);
  };

  /**
   * Refresh the time-to-live for the session with the given `sid`.
   *
   * @param {String} sid
   * @param {Session} sess
   * @param {Function} fn
   * @api public
   */

  RedisStore.prototype.touch = function (sid, sess, fn) {
    var store = this;
    var psid = store.prefix + sid;
    if (!fn) fn = noop;

    var ttl = getTTL(store, sess);

    debug('EXPIRE "%s" ttl:%s', sid, ttl);
    store.client.expire(psid, ttl, function (er) {
      if (er) return fn(er);
      debug('EXPIRE complete');
      fn.apply(this, arguments);
    });
  };

  return RedisStore;
};

