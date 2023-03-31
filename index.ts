import App from "./src/app";

const { NODE_ENV } = process.env;
// eslint-disable-next-line global-require
const APP_PORT = process.env.PORT || "8080";

App.listen(APP_PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server started at port ${APP_PORT}`);
});

export {};
