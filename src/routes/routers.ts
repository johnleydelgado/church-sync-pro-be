import { Router } from 'express';
import { createPayment, tesst } from '../controller';
import { authPlanningCenter, authQuickBook, callBackPC, callBackQBO } from '../controller/auth';
// import { authorized } from '../utils/authorization';
import { verifySession } from 'supertokens-node/recipe/session/framework/express';
import { pcRoutes, qboRoutes, userRoutes } from '../constant/routes';
import { getBatches, getFunds } from '../controller/planning-center';
import { createSettings, createUser, getUserRelated, updateUser } from '../controller/user';
import { addTokenInUser } from '../controller/db';
import { getAllQboData } from '../controller/qbo';
const routers = Router();
// routers.post("/start", authorized, startTask);
routers.get('/', tesst);
routers.get('/authQB', verifySession(), authQuickBook);
routers.get('/authPC', verifySession(), authPlanningCenter);
routers.post('/callBackQBO', verifySession(), callBackQBO);
routers.post('/callBackPC', verifySession(), callBackPC);
// routers.get('/getBatches', verifySession(), getBatches);
routers.post('/createPayment', verifySession(), createPayment);

routers.get(pcRoutes.getFunds, verifySession(), getFunds);
routers.get(pcRoutes.getBatches, verifySession(), getBatches);

routers.post(qboRoutes.getAllQboData, verifySession(), getAllQboData);

routers.post(userRoutes.updateUser, verifySession(), updateUser);
routers.post(userRoutes.createUser, verifySession(), createUser);
routers.post(userRoutes.addTokenInUser, verifySession(), addTokenInUser);
routers.post(userRoutes.createSettings, verifySession(), createSettings);
routers.get(userRoutes.getUserRelated, verifySession(), getUserRelated);

export default routers;
