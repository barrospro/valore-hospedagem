'use strict';
const handler = require('../server');

module.exports = (req, res) => {
  return handler(req, res);
};
