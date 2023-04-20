import { aws_certificatemanager as acm, aws_route53 as route53, aws_ssm as ssm, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Common } from "./common";

const common = new Common();

// Stack for application domain certificate
export class CertificateStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Wildcard certificate
    const certificate = new acm.Certificate(this, "Certificate", {
      certificateName: common.getResourceName("certificate"),
      domainName: common.getDomain(),
      subjectAlternativeNames: ["*." + common.getDomain()],
      validation: acm.CertificateValidation.fromDns(
        route53.HostedZone.fromLookup(this, "HostedZone", {
          domainName: common.getEnvironment().domain,
        })
      ),
    });

    // Put parameter: certificateArn
    new ssm.StringParameter(this, "CertificateParameter", {
      parameterName: common.getResourceNamePath("certificateArn"),
      stringValue: certificate.certificateArn,
    });
  }
}
