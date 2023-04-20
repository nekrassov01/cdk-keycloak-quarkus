import { Stack, StackProps } from "aws-cdk-lib";
import * as imagedeploy from "cdk-docker-image-deployment";
import { Construct } from "constructs";
import { Common } from "./common";

const common = new Common();
const imageName = "keycloak";

export class KeycloakBuildStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Create Dockerfile dynamically using parameters in 'cdk.json'
    common.createDockerfile(imageName);

    // Deploy container image via codebuild
    new imagedeploy.DockerImageDeployment(this, "KeycloakImageDeploy", {
      source: imagedeploy.Source.directory(common.getContainer(imageName).imagePath),
      destination: imagedeploy.Destination.ecr(common.getContainerRepository(this, imageName), {
        tag: common.getContainer(imageName).tag,
      }),
    });
  }
}
