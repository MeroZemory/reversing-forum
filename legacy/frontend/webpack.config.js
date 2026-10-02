const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const webpack = require("webpack");
const dotenv = require("dotenv");

// .env 파일 로드
const env = dotenv.config().parsed || {};

// 환경 변수를 객체로 변환
const envKeys = Object.keys(env).reduce((prev, next) => {
  prev[`process.env.${next}`] = JSON.stringify(env[next]);
  return prev;
}, {});

module.exports = {
  mode: "development",
  entry: "./src/index.tsx",
  output: {
    filename: "bundle.js",
    path: path.resolve(__dirname, "dist"),
    clean: true,
    publicPath: "/",
  },
  devtool: "source-map",
  devServer: {
    static: "./dist",
    hot: true,
    port: 8080,
    host: "0.0.0.0",
    historyApiFallback: true,
    proxy: [
      {
        context: ["/api"],
        target: "http://backend:8000",
        changeOrigin: true,
      },
    ],
  },
  resolve: {
    extensions: [".ts", ".tsx", ".js"],
  },
  module: {
    rules: [
      {
        test: /\.(ts|tsx)$/,
        use: "ts-loader",
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        use: ["style-loader", "css-loader", "postcss-loader"],
      },
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: "public/index.html",
    }),
    new webpack.DefinePlugin({
      // .env 파일의 모든 환경 변수 설정
      ...envKeys,
      // 기본값 설정 (환경 변수가 없을 경우)
      "process.env.REACT_APP_GOOGLE_CLIENT_ID": JSON.stringify(
        env.REACT_APP_GOOGLE_CLIENT_ID || "your-google-client-id"
      ),
    }),
  ],
};
