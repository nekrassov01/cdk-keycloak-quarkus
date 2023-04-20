# cdk-keycloak-quarkus

Deploy a Quarkus-based Keycloak cluster with Amazon ECS.

## Prerequisites

- A Route53 public hosted zone with any domain name already exists.
- Use Amazon ECR for the container registry. The repository must be created in advance.
- CodeCommit is assumed as the code repository.

## Ideas

- Include information such as account ID, region, repository, app, container image, etc. in `cdk.json` and use them as parameters to control stack construction.
- Define common classes for different parameters for various environments such as dev, stg, prod, etc., so that stack construction can be separated for each environment.
- Implement schedule-based scaling in addition to CPUUtilization-based scaling.

## Stack Information

| Stack Name                         | Description                                                                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| cdk-keycloak-quarkus-cert-stack    | Create a wildcard certificate to attach to the application load balancer.                                                                           |
| cdk-keycloak-quarkus-build-stack   | Use the [cdk-docker-image-deployment](https://github.com/cdklabs/cdk-docker-image-deployment) library to build a Keycloak image and push it to ECR. |
| cdk-keycloak-quarkus-cluster-stack | Deploy a Keycloak cluster on Fargate using the container image pushed to ECR.                                                                       |
