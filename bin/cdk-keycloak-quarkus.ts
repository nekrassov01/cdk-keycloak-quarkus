#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { writeFileSync } from "fs";
import "source-map-support/register";
import { CertificateStack } from "../lib/cdk-certificate-stack";
import { KeycloakStack } from "../lib/cdk-keycloak-stack";
import { Common } from "../lib/common";

const common = new Common();

// Accident prevention
common.verifyEnvironment();
common.verifyCallerAccount();
common.verifyBranch();
common.verifyContainer();

// Get `env` for deploying stacks from 'cdk.json'
const targetEnv = common.getEnvironment();
const env = {
  account: targetEnv.account,
  region: targetEnv.region,
};

// Create stack name list
const stackMap = {
  certificateStack: common.getId("CertificateStack"),
  keycloakStack: common.getId("KeycloakStack"),
};

// Export stack name list to file
writeFileSync("stack-map.json", JSON.stringify(stackMap, undefined, 2));

// Deploy stacks
const app = new App();
const certificateStack = new CertificateStack(app, stackMap.certificateStack, {
  env: env,
  terminationProtection: common.isProductionOrStaging(),
});
const keycloakStack = new KeycloakStack(app, stackMap.keycloakStack, {
  env: env,
  terminationProtection: common.isProductionOrStaging(),
});

// Dependencies for parameter passing via SSM parameter store
keycloakStack.addDependency(certificateStack);

// Tagging all resources
common.addTags(app);
