import { Router } from 'express';
import { createPayment, manualSync, tesst } from '../controller';
import {
  authPlanningCenter,
  authQuickBook,
  authStripe,
  callBackPC,
  callBackQBO,
  callBackStripe,
} from '../controller/auth';
// import { authorized } from '../utils/authorization';
import { verifySession } from 'supertokens-node/recipe/session/framework/express';
import { pcRoutes, qboRoutes, stripeRoutes, userRoutes } from '../constant/routes';
import { getBatches, getFunds, getRegistrationEvents } from '../controller/planning-center';
import { createSettings, createUser, getUserRelated, updateUser } from '../controller/user';
import { addTokenInUser } from '../controller/db';
import { getAllQboData } from '../controller/qbo';
import { getStripePayouts, syncStripePayout } from '../controller/stripe';
const routers = Router();
// routers.post("/start", authorized, startTask);
routers.get('/', tesst);
routers.get('/authQB', verifySession(), authQuickBook);
routers.get('/authPC', verifySession(), authPlanningCenter);
routers.get('/authStripe', authStripe);
routers.post('/callBackQBO', verifySession(), callBackQBO);
routers.post('/callBackPC', verifySession(), callBackPC);
routers.post('/callBackStripe', callBackStripe);

// routers.get('/getBatches', verifySession(), getBatches);
routers.post('/createPayment', verifySession(), createPayment);

routers.get(pcRoutes.getFunds, verifySession(), getFunds);
routers.get(pcRoutes.getBatches, verifySession(), getBatches);
routers.get(pcRoutes.getRegistrationEvents, verifySession(), getRegistrationEvents);

routers.get(stripeRoutes.getStripePayouts, verifySession(), getStripePayouts);
routers.get(stripeRoutes.syncStripePayout, verifySession(), syncStripePayout);

routers.post(qboRoutes.getAllQboData, verifySession(), getAllQboData);

routers.post(userRoutes.updateUser, verifySession(), updateUser);
routers.post(userRoutes.createUser, verifySession(), createUser);
routers.post(userRoutes.addTokenInUser, verifySession(), addTokenInUser);
routers.post(userRoutes.createSettings, verifySession(), createSettings);
routers.get(userRoutes.getUserRelated, verifySession(), getUserRelated);
routers.post(userRoutes.manualSync, verifySession(), manualSync);

export default routers;
