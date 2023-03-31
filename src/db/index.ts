import { Sequelize } from "sequelize";

const enVariables = require("./config/config.json");

const env = process.env.NODE_ENV || "development";
const config = enVariables[env];

const sequelize = new Sequelize(
  config.database,
  config.username,
  config.password,
  config
);

export default sequelize;
