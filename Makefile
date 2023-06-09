STAGING_PROJECT=church-sync-pro-385703

# gcloud sql instances create db-csp --project=church-sync-pro-385703 --database-version=POSTGRES_13 --tier=db-f1-micro --region=us-central1
# gcloud sql users set-password postgres --host=% --instance=db-csp --password=n6yZ535P
# gcloud sql databases create csp --instance=db-csp
# gcloud sql instances describe db-csp --format="value(connectionName)" (result:church-sync-pro-385703:us-central1:db-csp)
# gcloud run deploy supertokens --image gcr.io/church-sync-pro-385703/supertokens-postgresql:4.4 --allow-unauthenticated --set-env-vars POSTGRESQL_CONNECTION_URI='postgresql://postgres:n6yZ535P@/csp?host=/cloudsql/church-sync-pro-385703:us-central1:db-csp' --add-cloudsql-instances church-sync-pro-385703:us-central1:db-csp --project church-sync-pro-385703

# 	docker build --platform linux/amd64 --cache-from gcr.io/church-sync-pro-385703/supertokens-postgresql:4.4 -t gcr.io/church-sync-pro-385703/supertokens-postgresql:4.4 .
# 	docker push gcr.io/church-sync-pro-385703/supertokens-postgresql:4.4
# 	gcloud run deploy supertokens --image gcr.io/church-sync-pro-385703/supertokens-postgresql:4.4 --port 3567 --allow-unauthenticated --set-env-vars POSTGRESQL_CONNECTION_URI='postgresql://postgres:n6yZ535P@/csp?host=/cloudsql/church-sync-pro-385703:us-central1:db-csp' --add-cloudsql-instances church-sync-pro-385703:us-central1:db-csp --project church-sync-pro-385703


# postgresql://username:password@/dbname?host=/cloudsql/instance-connection-name
# docker run -p 3567:3567 -e POSTGRESQL_CONNECTION_URI="postgresql://postgres:n6yZ535P@/csp?host=/cloudsql/church-sync-pro-385703:us-central1:db-csp" gcr.io/church-sync-pro-385703/supertokens-postgresql:4.6

# NOTE once 

deploy-stg:
	make deploy-supertoken GOOGLE_CLOUD_PROJECT=${STAGING_PROJECT} NODE_ENV=staging \
	VPC_CONNECTOR="--vpc-connector projects/${STAGING_PROJECT}/locations/us-central1/connectors/csp-vpc"
	make deploy-backend GOOGLE_CLOUD_PROJECT=${STAGING_PROJECT} NODE_ENV=staging \
	VPC_CONNECTOR="--vpc-connector projects/${STAGING_PROJECT}/locations/us-central1/connectors/csp-vpc"

deploy-supertoken:
	docker build --platform linux/amd64 --cache-from gcr.io/${GOOGLE_CLOUD_PROJECT}/supertokens-postgresql:4.4 -t gcr.io/${GOOGLE_CLOUD_PROJECT}/supertokens-postgresql:4.4  -f DockerfileST .
	docker push gcr.io/${GOOGLE_CLOUD_PROJECT}/supertokens-postgresql:4.4
	gcloud run deploy supertokens --image gcr.io/${GOOGLE_CLOUD_PROJECT}/supertokens-postgresql:4.4 --project ${GOOGLE_CLOUD_PROJECT} \
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
		--set-env-vars POSTGRESQL_CONNECTION_URI='postgresql://postgres:asd123asd@10.94.96.3/supertokens',SUPERTOKENS_PORT=3567,API_KEYS=18be6f53-2e23-4fcc-bd17-2fecb798106e \
		--project ${GOOGLE_CLOUD_PROJECT}

deploy-backend:
	docker build --platform linux/amd64 --cache-from gcr.io/${GOOGLE_CLOUD_PROJECT}/csp-be -t gcr.io/${GOOGLE_CLOUD_PROJECT}/csp-be -f DockerfileBE .
	docker push gcr.io/${GOOGLE_CLOUD_PROJECT}/csp-be
	gcloud run deploy csp-be --image gcr.io/${GOOGLE_CLOUD_PROJECT}/csp-be --project ${GOOGLE_CLOUD_PROJECT} \
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
	--set-env-vars `cat .env.staging | xargs | tr ' ' ','` \
	--project ${GOOGLE_CLOUD_PROJECT}