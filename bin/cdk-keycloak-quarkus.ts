#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { writeFileSync } from "fs";
import "source-map-support/register";
import { KeycloakBuildStack } from "../lib/cdk-keycloak-quarkus-build-stack";
import { CertificateStack } from "../lib/cdk-keycloak-quarkus-cert-stack";
import { KeycloakClusterStack } from "../lib/cdk-keycloak-quarkus-cluster-stack";
import { Common } from "../lib/common";

const common = new Common();

// Accident prevention
common.verifyEnvironment();
common.verifyCallerAccount();
common.verifyBranch();
common.verifyContainer("keycloak");

// Get `env` for deploying stacks from 'cdk.json'
const targetEnv = common.getEnvironment();
const env = {
  account: targetEnv.account,
  region: targetEnv.region,
};

// Create stack name list
const stackMap = {
  certificateStack: common.getId("CertificateStack"),
  keycloakBuildStack: common.getId("KeycloakBuildStack"),
  keycloakClusterStack: common.getId("KeycloakClusterStack"),
};

// Export stack name list to file
writeFileSync("stack-map.json", JSON.stringify(stackMap, undefined, 2));

// Deploy stacks
const app = new App();
const certificateStack = new CertificateStack(app, stackMap.certificateStack, {
  env: env,
  terminationProtection: common.isProductionOrStaging(),
});
const keycloakBuildStack = new KeycloakBuildStack(app, stackMap.keycloakBuildStack, {
  env: env,
  terminationProtection: common.isProductionOrStaging(),
});
const keycloakClusterStack = new KeycloakClusterStack(app, stackMap.keycloakClusterStack, {
  env: env,
  terminationProtection: common.isProductionOrStaging(),
});

// Dependencies for parameter passing via SSM parameter store
keycloakClusterStack.addDependency(certificateStack);

// Tagging all resources
common.addTags(app);
