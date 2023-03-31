import { Router } from 'express';
import routers from './routers';

// import taskRouter from "./taskRouter";

const router = Router();

router.use('/', routers);

export default router;
