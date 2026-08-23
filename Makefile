STAGING_PROJECT=church-sync-pro-385703

# Secrets are NOT stored in this file. Export them before running deploy-supertoken: require-supertoken-secrets
#   export SUPERTOKENS_DB_URI='postgresql://USER:PASSWORD@HOST:25060/supertokens'
#   export SUPERTOKENS_API_KEY='...'
require-supertoken-secrets:
ifndef SUPERTOKENS_DB_URI
	$(error SUPERTOKENS_DB_URI is not set - export it before deploying)
endif
ifndef SUPERTOKENS_API_KEY
	$(error SUPERTOKENS_API_KEY is not set - export it before deploying)
endif

# gcloud sql instances create db-csp --project=church-sync-pro-385703 --database-version=POSTGRES_13 --tier=db-f1-micro --region=us-central1
# gcloud sql users set-password postgres --host=% --instance=db-csp --password=<password>
# gcloud sql databases create csp --instance=db-csp
# gcloud sql instances describe db-csp --format="value(connectionName)" (result:church-sync-pro-385703:us-central1:db-csp)
# gcloud run deploy supertokens --image gcr.io/church-sync-pro-385703/supertokens-postgresql:4.4 --allow-unauthenticated --set-env-vars POSTGRESQL_CONNECTION_URI='postgresql://<user>:<password>@/csp?host=/cloudsql/church-sync-pro-385703:us-central1:db-csp' --add-cloudsql-instances church-sync-pro-385703:us-central1:db-csp --project church-sync-pro-385703

# 	docker build --platform linux/amd64 --cache-from gcr.io/church-sync-pro-385703/supertokens-postgresql:4.4 -t gcr.io/church-sync-pro-385703/supertokens-postgresql:4.4 .
# 	docker push gcr.io/church-sync-pro-385703/supertokens-postgresql:4.4
# 	gcloud run deploy supertokens --image gcr.io/church-sync-pro-385703/supertokens-postgresql:4.4 --port 3567 --allow-unauthenticated --set-env-vars POSTGRESQL_CONNECTION_URI='postgresql://<user>:<password>@/csp?host=/cloudsql/church-sync-pro-385703:us-central1:db-csp' --add-cloudsql-instances church-sync-pro-385703:us-central1:db-csp --project church-sync-pro-385703


# postgresql://username:password@/dbname?host=/cloudsql/instance-connection-name
# docker run -p 3567:3567 -e POSTGRESQL_CONNECTION_URI="postgresql://<user>:<password>@/csp?host=/cloudsql/church-sync-pro-385703:us-central1:db-csp" gcr.io/church-sync-pro-385703/supertokens-postgresql:4.6

# NOTE once 

# Staging deploys SuperTokens AND the backend. The deploy-backend line was missing,
# which is why csp-be had never been deployed and make deploy-prd was the only way to
# ship backend code.
deploy-stg:
	make deploy-supertoken GOOGLE_CLOUD_PROJECT=${STAGING_PROJECT} NODE_ENV=staging SUPER_TOKEN=supertokens \
	VPC_CONNECTOR="--vpc-connector projects/${STAGING_PROJECT}/locations/us-central1/connectors/csp-vpc"
	make deploy-backend GOOGLE_CLOUD_PROJECT=${STAGING_PROJECT} NODE_ENV=staging PROJECT_NAME=csp-be ENV_VAR=.env.staging \
	VPC_CONNECTOR="--vpc-connector projects/${STAGING_PROJECT}/locations/us-central1/connectors/csp-vpc"

# Backend only, without redeploying SuperTokens.
deploy-stg-be:
	make deploy-backend GOOGLE_CLOUD_PROJECT=${STAGING_PROJECT} NODE_ENV=staging PROJECT_NAME=csp-be ENV_VAR=.env.staging \
	VPC_CONNECTOR="--vpc-connector projects/${STAGING_PROJECT}/locations/us-central1/connectors/csp-vpc"


# deploy-prd:
# 	make deploy-supertoken GOOGLE_CLOUD_PROJECT=${STAGING_PROJECT} NODE_ENV=production SUPER_TOKEN=supertokens-prd \
# 	VPC_CONNECTOR="--vpc-connector projects/${STAGING_PROJECT}/locations/us-central1/connectors/csp-vpc"
# 	make deploy-backend GOOGLE_CLOUD_PROJECT=${STAGING_PROJECT} NODE_ENV=production PROJECT_NAME=csp-be-prd ENV_VAR=.env.production \
# 	VPC_CONNECTOR="--vpc-connector projects/${STAGING_PROJECT}/locations/us-central1/connectors/csp-vpc"

deploy-prd:
	make deploy-backend GOOGLE_CLOUD_PROJECT=${STAGING_PROJECT} NODE_ENV=production PROJECT_NAME=csp-be-prd ENV_VAR=.env.production \
	VPC_CONNECTOR="--vpc-connector projects/${STAGING_PROJECT}/locations/us-central1/connectors/csp-vpc"

deploy-supertoken:
	docker build --platform linux/amd64 --cache-from gcr.io/${GOOGLE_CLOUD_PROJECT}/supertokens-postgresql:4.4 -t gcr.io/${GOOGLE_CLOUD_PROJECT}/supertokens-postgresql:4.4  -f DockerfileST .
	docker push gcr.io/${GOOGLE_CLOUD_PROJECT}/supertokens-postgresql:4.4
	gcloud run deploy ${SUPER_TOKEN} --image gcr.io/${GOOGLE_CLOUD_PROJECT}/supertokens-postgresql:4.4 --project ${GOOGLE_CLOUD_PROJECT} \
		--platform managed \
		--region us-central1 \
		--port 3567 \
		--cpu 1 \
		--memory 256Mi \
		--concurrency 5 \
		--max-instances 10 \
		--timeout 1200 \
		--ingress all \
		--allow-unauthenticated \
		${VPC_CONNECTOR} \
		--set-env-vars POSTGRESQL_CONNECTION_URI='$(SUPERTOKENS_DB_URI)',SUPERTOKENS_PORT=3567,API_KEYS=$(SUPERTOKENS_API_KEY) \
		--project ${GOOGLE_CLOUD_PROJECT}
	gcloud run services update-traffic ${SUPER_TOKEN} --to-latest --project ${GOOGLE_CLOUD_PROJECT} --platform managed --region us-central1

deploy-backend:
	docker build --platform linux/amd64 --cache-from gcr.io/${GOOGLE_CLOUD_PROJECT}/${PROJECT_NAME} -t gcr.io/${GOOGLE_CLOUD_PROJECT}/${PROJECT_NAME} -f DockerfileBE .
	docker push gcr.io/${GOOGLE_CLOUD_PROJECT}/${PROJECT_NAME}
	gcloud run deploy ${PROJECT_NAME} --image gcr.io/${GOOGLE_CLOUD_PROJECT}/${PROJECT_NAME} --project ${GOOGLE_CLOUD_PROJECT} \
		--platform managed \
		--region us-central1 \
		--port 8080 \
		--cpu 1 \
		--memory 512Mi \
		--concurrency 5 \
		--max-instances 10 \
		--timeout 1200 \
		--ingress all \
		--allow-unauthenticated \
		${VPC_CONNECTOR} \
		--set-env-vars `cat ${ENV_VAR} | xargs | tr ' ' ','` \
		--project ${GOOGLE_CLOUD_PROJECT}
	gcloud run services update-traffic ${PROJECT_NAME} --to-latest --project ${GOOGLE_CLOUD_PROJECT} --platform managed --region us-central1

# --- DB migrations (manual; deploy does NOT run these). See DEPLOY.md ---
migrate-prd:
	NODE_ENV=uat-prd npx sequelize-cli db:migrate

migrate-uat:
	NODE_ENV=uat npx sequelize-cli db:migrate
