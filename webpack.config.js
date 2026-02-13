const path = require('path');

module.exports = {
  mode: 'production',
  target: 'webworker',
  entry: {
    background: './background.js'
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js'
  },
  resolve: {
    extensions: ['.js']
  }
};
