const path = require('path');
const webpack = require('webpack');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = (env, argv) => {
  const isProduction = argv.mode === 'production';

  return {
    entry: {
      'background/service-worker': './src/background/service-worker.ts',
      'content/content-script': './src/content/content-script.ts',
      'popup/popup': './src/popup/popup.ts',
      'options/options': './src/options/options.ts',
      'offscreen/offscreen': './src/offscreen/offscreen.ts',
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      clean: true,
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: 'ts-loader',
          exclude: /node_modules|src\/ffmpeg|public\/ffmpeg|dist\/ffmpeg/,
        },
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader'],
          exclude: /ffmpeg/,
        },
      ],
    },
    resolve: {
      extensions: ['.ts', '.tsx', '.js'],
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
      // Don't resolve modules in FFmpeg directories
      modules: ['node_modules', 'src'],
    },
    plugins: [
      new CopyWebpackPlugin({
        patterns: [
          { from: 'public/icons', to: 'icons' },
          { from: 'manifest.json', to: 'manifest.json' },
          {
            from: path.resolve(__dirname, 'public/ffmpeg'),
            to: 'ffmpeg'
          },
        ],
      }),
      new HtmlWebpackPlugin({
        template: './src/popup/popup.html',
        filename: 'popup/popup.html',
        chunks: ['popup/popup'],
        inject: 'body',
      }),
      new HtmlWebpackPlugin({
        template: './src/options/options.html',
        filename: 'options/options.html',
        chunks: ['options/options'],
        inject: 'body',
      }),
      new HtmlWebpackPlugin({
        template: './src/offscreen/offscreen.html',
        filename: 'offscreen/offscreen.html',
        chunks: ['offscreen/offscreen'],
        inject: 'body',
        minify: false,
      }),
    ],
    devtool: isProduction ? false : 'source-map',
    optimization: {
      minimize: isProduction,
      // Exclude FFmpeg files from optimization
      minimizer: isProduction ? [
        '...', // Use default minimizers
      ] : [],
    },
    // Ignore FFmpeg directories in watch mode for faster rebuilds
    watchOptions: {
      ignored: /ffmpeg/,
    },
  };
};

