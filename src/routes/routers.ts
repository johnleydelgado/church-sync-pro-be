import { Router } from 'express';
import { createPayment, tesst } from '../controller';
import { authPlanningCenter, authQuickBook, callBackPC, callBackQBO } from '../controller/auth';
// import { authorized } from '../utils/authorization';
import { verifySession } from 'supertokens-node/recipe/session/framework/express';
import { pcRoutes, userRoutes } from '../constant/routes';
import { getBatches, getFunds } from '../controller/planning-center';
import { createUser, updateUser } from '../controller/user';
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

routers.post(userRoutes.updateUser, verifySession(), updateUser);
routers.post(userRoutes.createUser, verifySession(), createUser);

export default routers;
