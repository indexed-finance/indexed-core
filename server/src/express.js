const bodyParser = require('body-parser');
const cors = require('cors')
const express = require('express');

const app = express();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cors());

module.exports = app;