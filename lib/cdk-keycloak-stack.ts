import {
  Stack,
  StackProps,
  aws_applicationautoscaling as aas,
  aws_secretsmanager as asm,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_logs as logs,
  aws_rds as rds,
  aws_route53 as route53,
  aws_route53_targets as route53targets,
  aws_ssm as ssm,
} from "aws-cdk-lib";
import { Destination, DockerImageDeployment, Source } from "cdk-docker-image-deployment";
import { Construct } from "constructs";
import { Common } from "./common";

const common = new Common();
const params = common.loadConfig();
const serviceName = "keycloak";
const dbUserName = "admin";
const domainName = `auth.${common.getDomain()}`;
const env = common.getEnvironment();
const containerConfig = common.getContainer(serviceName);

// Stack for ECS on Fargate running Keycloak authentication infrastructure
// NOTE: Assumes Quarkus distribution
export class KeycloakStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    /*********
     * VPC
     *********/

    // Base Vpc
    const vpc = new ec2.Vpc(this, "VPC", {
      ipAddresses: common.getVpcParameter().ipAddresses,
      enableDnsHostnames: true,
      enableDnsSupport: true,
      natGateways: common.getVpcParameter().natGateways,
      maxAzs: common.getVpcParameter().maxAzs,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: common.getVpcParameter().subnetCidrMask,
        },
        {
          name: "Private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: common.getVpcParameter().subnetCidrMask,
        },
      ],
    });
    const vpcPublicSubnets = vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC });
    const vpcPrivateSubnets = vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS });

    /*********
     * RDS
     *********/

    // Database cluster parameter group
    const dbClusterParameterGroup = new rds.ParameterGroup(this, "DBClusterParameterGroup", {
      engine: rds.DatabaseClusterEngine.auroraMysql({
        version: rds.AuroraMysqlEngineVersion.VER_3_02_0,
      }),
      description: `Cluster parameter group for aurora-mysql8.0 for ${params.target.application} authentication infrastructure`,
      parameters: {
        slow_query_log: "1",
      },
    });
    dbClusterParameterGroup.bindToCluster({});
    (dbClusterParameterGroup.node.defaultChild as rds.CfnDBClusterParameterGroup).dbClusterParameterGroupName =
      common.getResourceName(`${serviceName}-db-cluster-pg-aurora-mysql8`);

    // Database instance parameter group
    const dbInstanceParameterGroup = new rds.ParameterGroup(this, "DBInstanceParameterGroup", {
      engine: rds.DatabaseClusterEngine.auroraMysql({
        version: rds.AuroraMysqlEngineVersion.VER_3_02_0,
      }),
      description: `Instance parameter group for aurora-mysql8.0 for ${params.target.application} authentication infrastructure`,
    });
    dbInstanceParameterGroup.bindToInstance({});
    (dbInstanceParameterGroup.node.defaultChild as rds.CfnDBParameterGroup).dbParameterGroupName =
      common.getResourceName(`${serviceName}-db-instance-pg-aurora-mysql8`);

    // Database subnet group
    const dbSubnetGroup = new rds.SubnetGroup(this, "DBSubnetGroup", {
      subnetGroupName: common.getResourceName(`${serviceName}-db-subnet-group`),
      description: common.getResourceName(`${serviceName}-db-subnet-group`),
      removalPolicy: common.getRemovalPolicy(),
      vpc: vpc,
      vpcSubnets: vpcPrivateSubnets,
    });

    // Database security group
    const dbSecurityGroupName = common.getResourceName(`${serviceName}-db-security-group`);
    const dbSecurityGroup = new ec2.SecurityGroup(this, "DBSecurityGroup", {
      securityGroupName: dbSecurityGroupName,
      description: dbSecurityGroupName,
      vpc: vpc,
      allowAllOutbound: true,
    });
    common.addNameTag(dbSecurityGroup, dbSecurityGroupName);

    // Database credential
    const dbSecret = new asm.Secret(this, "DBSecret", {
      secretName: common.getResourceName(`${serviceName}-db-secret`),
      description: "Credentials for database",
      generateSecretString: {
        generateStringKey: "password",
        excludeCharacters: " % +~`#$&*()|[]{}:;<>?!'/@\"\\",
        passwordLength: 30,
        secretStringTemplate: JSON.stringify({ username: dbUserName }),
      },
    });

    // Aurora Serverless v2
    const dbCluster = new rds.DatabaseCluster(this, "DBCluster", {
      engine: rds.DatabaseClusterEngine.auroraMysql({
        version: rds.AuroraMysqlEngineVersion.VER_3_02_0,
      }),
      clusterIdentifier: common.getResourceName(`${serviceName}-db-cluster`),
      instanceIdentifierBase: common.getResourceName(`${serviceName}-db-instance`),
      defaultDatabaseName: serviceName,
      deletionProtection: common.getRdsParameter().deletionProtection,
      credentials: rds.Credentials.fromSecret(dbSecret),
      instanceProps: {
        vpc: vpc,
        vpcSubnets: vpcPrivateSubnets,
        instanceType: new ec2.InstanceType("serverless"),
        securityGroups: [dbSecurityGroup],
        parameterGroup: dbInstanceParameterGroup,
        enablePerformanceInsights: true,
      },
      subnetGroup: dbSubnetGroup,
      parameterGroup: dbClusterParameterGroup,
      backup: {
        retention: common.getRdsParameter().buckupRetentionDays,
      },
      storageEncrypted: true,
      removalPolicy: common.getRemovalPolicy(),
      copyTagsToSnapshot: true,
      cloudwatchLogsExports: ["error", "general", "slowquery", "audit"],
      cloudwatchLogsRetention: common.getLogsRetentionDays(),
    });
    (dbCluster.node.defaultChild as rds.CfnDBCluster).serverlessV2ScalingConfiguration = {
      minCapacity: common.getRdsParameter().scaling.minCapacity,
      maxCapacity: common.getRdsParameter().scaling.maxCapacity,
    };
    const dbListenerPort = 3306;
    dbCluster.connections.allowInternally(
      ec2.Port.tcp(dbListenerPort),
      "Allow resources with this security group connect to database"
    );
    dbCluster.connections.allowFrom(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(dbListenerPort),
      "Allow resources in VPC connect to database"
    );

    /*********
     * ECS
     *********/

    // Create Dockerfile dynamically using parameters in 'cdk.json'
    common.createDockerfile(serviceName);

    // Get ECR repository
    const containerRepository = ecr.Repository.fromRepositoryArn(
      this,
      "ContainerRepository",
      `arn:aws:ecr:${env.region}:${env.account}:repository/${containerConfig.repositoryName}`
    );

    // Deploy container image via codebuild
    new DockerImageDeployment(this, "KeycloakImageDeploy", {
      source: Source.directory(containerConfig.imagePath),
      destination: Destination.ecr(containerRepository, { tag: containerConfig.tag }),
    });

    // Port settings
    const containerPort = 8080;
    const ecsPortSettings = [
      {
        Port: containerPort,
        Protocol: ecs.Protocol.TCP,
        Description: "keycloak: http",
        ECSServiceConnection: false,
      },
      {
        Port: 7800,
        Protocol: ecs.Protocol.TCP,
        Description: "keycloak: jgroups-tcp",
        ECSServiceConnection: true,
      },
      {
        Port: 57800,
        Protocol: ecs.Protocol.TCP,
        Description: "keycloak: jgroups-tcp-fd",
        ECSServiceConnection: true,
      },
    ];

    // ECS cluster
    const ecsCluster = new ecs.Cluster(this, "ECSCluster", {
      clusterName: common.getResourceName(`${serviceName}-cluster`),
      vpc: vpc,
      containerInsights: true,
    });
    ecsCluster.node.addDependency(dbCluster);

    // ECS task execution role
    const ecsTaskExecutionRole = new iam.Role(this, "ECSTaskExecutionRole", {
      roleName: common.getResourceName(`${serviceName}-task-execution-role`),
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal("ecs.amazonaws.com"),
        new iam.ServicePrincipal("ecs-tasks.amazonaws.com")
      ),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonEC2ContainerRegistryReadOnly")],
    });

    // ECS task role
    const ecsTaskRole = new iam.Role(this, "ECSTaskRole", {
      roleName: common.getResourceName(`${serviceName}-task-role`),
      assumedBy: new iam.CompositePrincipal(new iam.ServicePrincipal("ecs-tasks.amazonaws.com")),
    });

    // ECS task definition
    const ecsTaskDefinition = new ecs.FargateTaskDefinition(this, "ECSTaskDefinitionBase", {
      family: common.getResourceName(`${serviceName}-task-definition`),
      cpu: common.getEcsParameter().taskDefinition.cpu,
      memoryLimitMiB: common.getEcsParameter().taskDefinition.memoryLimitMiB,
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
      },
      executionRole: ecsTaskExecutionRole,
      taskRole: ecsTaskRole,
    });

    // Keycloak credential
    const userSecret = new asm.Secret(this, "UserSecret", {
      secretName: common.getResourceName(`${serviceName}-user-secret`),
      description: "Credentials for keycloak",
      generateSecretString: {
        generateStringKey: "password",
        excludePunctuation: true,
        passwordLength: 12,
        secretStringTemplate: JSON.stringify({ username: serviceName }),
      },
    });

    // ECS log group
    const ecsLogGroup = new logs.LogGroup(this, "ECSLogGroup", {
      logGroupName: common.getResourceNamePath(`ecs/${serviceName}`),
      retention: common.getLogsRetentionDays(),
      removalPolicy: common.getRemovalPolicy(),
    });

    // ECS port mappings
    const ecsPortMappings: ecs.PortMapping[] = [];
    ecsPortSettings.map((param) => {
      ecsPortMappings.push({
        containerPort: param.Port,
        protocol: param.Protocol,
      });
    });

    // Task definition with container definition added
    ecsTaskDefinition.addContainer("ECSTaskDefinition", {
      containerName: serviceName,
      image: ecs.ContainerImage.fromEcrRepository(containerRepository, containerConfig.tag),
      command: common.getEcsParameter().taskDefinition.command,
      secrets: {
        KC_DB_PASSWORD: ecs.Secret.fromSecretsManager(dbCluster.secret!, "password"),
        KEYCLOAK_ADMIN: ecs.Secret.fromSecretsManager(userSecret, "username"),
        KEYCLOAK_ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(userSecret, "password"),
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: ecsLogGroup,
        streamPrefix: serviceName,
      }),
      environment: {
        KC_CACHE_CONFIG_FILE: "cache-ispn-jdbc-ping.xml",
        KC_DB: "mysql",
        KC_DB_URL: `jdbc:mysql://${dbCluster.clusterEndpoint.hostname}:${dbListenerPort}/${serviceName}`,
        KC_DB_URL_DATABASE: serviceName,
        KC_DB_URL_HOST: dbCluster.clusterEndpoint.hostname,
        KC_DB_URL_PORT: String(dbListenerPort),
        KC_DB_USERNAME: dbUserName,
        KC_HOSTNAME: domainName,
        KC_HOSTNAME_STRICT_BACKCHANNEL: "true",
        KC_PROXY: "edge",
      },
      portMappings: ecsPortMappings,
    });

    // Allow execution role to read the secrets
    dbCluster.secret!.grantRead(ecsTaskDefinition.executionRole!);
    userSecret.grantRead(ecsTaskDefinition.executionRole!);

    // ECS service security group
    const ecsServiceSecurityGroupName = common.getResourceName(`${serviceName}-ecs-service-security-group`);
    const ecsServiceSecurityGroup = new ec2.SecurityGroup(this, "ECSServiceSecurityGroup", {
      securityGroupName: ecsServiceSecurityGroupName,
      description: ecsServiceSecurityGroupName,
      vpc: vpc,
      allowAllOutbound: true,
    });
    common.addNameTag(ecsServiceSecurityGroup, ecsServiceSecurityGroupName);

    // ECS service
    const ecsService = new ecs.FargateService(this, "ECSService", {
      serviceName: common.getResourceName(`${serviceName}-service`),
      cluster: ecsCluster,
      taskDefinition: ecsTaskDefinition,
      circuitBreaker: common.getEcsParameter().service.circuitBreaker,
      desiredCount: common.getEcsParameter().service.nodeCount,
      healthCheckGracePeriod: common.getEcsParameter().service.healthCheckGracePeriod,
      securityGroups: [ecsServiceSecurityGroup],
      //deploymentController: { type: ecs.DeploymentControllerType.CODE_DEPLOY },
    });

    // ECS allowed traffic
    ecsPortSettings.map((param) => {
      if (param.ECSServiceConnection) {
        ecsService.connections.allowFrom(
          ecsService.connections,
          param.Protocol === ecs.Protocol.TCP ? ec2.Port.tcp(param.Port) : ec2.Port.udp(param.Port),
          param.Description
        );
      }
    });

    // Allow ecs task connect to database
    dbCluster.connections.allowDefaultPortFrom(ecsService, "Allow ECS task connect to database");

    // ECS auto scaling capacity
    const ecsAutoScaling = ecsService.autoScaleTaskCount({
      minCapacity: common.getEcsParameter().service.scaling.base.minCapacity,
      maxCapacity: common.getEcsParameter().service.scaling.base.maxCapacity,
    });

    // ECS auto scaling by cpu utilization
    ecsAutoScaling.scaleOnCpuUtilization("ECSCPUScaling", {
      policyName: common.getResourceName(`${serviceName}-cpu-scaling-policy`),
      targetUtilizationPercent: common.getEcsParameter().service.scaling.base.cpuUtilization,
      scaleOutCooldown: common.getEcsParameter().service.scaling.base.scaleOutCooldown,
      scaleInCooldown: common.getEcsParameter().service.scaling.base.scaleInCooldown,
    });

    // ECS auto scaling by schedule
    ecsAutoScaling.scaleOnSchedule("ECSScalingOutBeforeOpening", {
      schedule: aas.Schedule.cron(common.getEcsParameter().service.scaling.schedule.beforeOpening.cron),
      minCapacity: common.getEcsParameter().service.scaling.schedule.beforeOpening.minCapacity,
      maxCapacity: common.getEcsParameter().service.scaling.schedule.beforeOpening.maxCapacity,
    });
    ecsAutoScaling.scaleOnSchedule("ECSScalingInAfterOpening", {
      schedule: aas.Schedule.cron(common.getEcsParameter().service.scaling.schedule.afterOpening.cron),
      minCapacity: common.getEcsParameter().service.scaling.schedule.afterOpening.minCapacity,
      maxCapacity: common.getEcsParameter().service.scaling.schedule.afterOpening.maxCapacity,
    });
    ecsAutoScaling.scaleOnSchedule("ECSScalingOutBeforeClosing", {
      schedule: aas.Schedule.cron(common.getEcsParameter().service.scaling.schedule.beforeClosing.cron),
      minCapacity: common.getEcsParameter().service.scaling.schedule.beforeClosing.minCapacity,
      maxCapacity: common.getEcsParameter().service.scaling.schedule.beforeClosing.maxCapacity,
    });
    ecsAutoScaling.scaleOnSchedule("ECSScalingInAfterClosing", {
      schedule: aas.Schedule.cron(common.getEcsParameter().service.scaling.schedule.afterClosing.cron),
      minCapacity: common.getEcsParameter().service.scaling.schedule.afterClosing.minCapacity,
      maxCapacity: common.getEcsParameter().service.scaling.schedule.afterClosing.maxCapacity,
    });

    // ALB security group
    const albSecurityGroupName = common.getResourceName(`${serviceName}-alb-security-group`);
    const albSecurityGroup = new ec2.SecurityGroup(this, "ALBSecurityGroup", {
      securityGroupName: albSecurityGroupName,
      description: albSecurityGroupName,
      vpc: vpc,
      allowAllOutbound: false,
    });
    common.addNameTag(albSecurityGroup, albSecurityGroupName);
    albSecurityGroup.addIngressRule(ec2.Peer.ipv4("0.0.0.0/0"), ec2.Port.tcp(443), "Allow from anyone on port 443");

    // ALB
    const alb = new elbv2.ApplicationLoadBalancer(this, "ALB", {
      loadBalancerName: common.getResourceName(`${serviceName}-alb`),
      vpc: vpc,
      vpcSubnets: vpcPublicSubnets,
      internetFacing: true,
      securityGroup: albSecurityGroup,
    });

    // ALB HTTPS listener
    const albListener = alb.addListener("ALBListener", {
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [
        {
          certificateArn: common.lazifyString(
            ssm.StringParameter.valueForTypedStringParameterV2(
              this,
              common.getResourceNamePath("certificateArn"),
              ssm.ParameterValueType.STRING
            )
          ),
        },
      ],
    });

    // ALB target group
    albListener.addTargets("ALBTarget", {
      targetGroupName: common.getResourceName(`${serviceName}-tg`),
      targets: [ecsService],
      healthCheck: {
        healthyThresholdCount: common.getEcsParameter().alb.healthyThresholdCount,
        interval: common.getEcsParameter().alb.interval,
        timeout: common.getEcsParameter().alb.timeout,
      },
      slowStart: common.getEcsParameter().alb.slowStart,
      stickinessCookieDuration: common.getEcsParameter().alb.stickinessCookieDuration,
      port: containerPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
    });

    // Alias record for ALB
    const albARecord = new route53.ARecord(this, "ALBARecord", {
      recordName: domainName,
      target: route53.RecordTarget.fromAlias(new route53targets.LoadBalancerTarget(alb)),
      zone: route53.HostedZone.fromLookup(this, "HostedZone", {
        domainName: env.domain,
      }),
    });
    albARecord.node.addDependency(alb);

    /*********
     * EC2
     *********/

    // Bastion host security group
    const bastionSecurityGroupName = common.getResourceName(`${serviceName}-bastion-security-group`);
    const bastionSecurityGroup = new ec2.SecurityGroup(this, "BastionSecurityGroup", {
      securityGroupName: bastionSecurityGroupName,
      description: bastionSecurityGroupName,
      vpc: vpc,
      allowAllOutbound: true,
    });
    common.addNameTag(bastionSecurityGroup, bastionSecurityGroupName);

    // Bastion host
    const bastion = new ec2.BastionHostLinux(this, "Bastion", {
      instanceName: common.getResourceName(`${serviceName}-bastion`),
      instanceType: new ec2.InstanceType(common.getEcsParameter().bastion.instanceType),
      vpc: vpc,
      securityGroup: bastionSecurityGroup,
    });

    // Override role name
    (bastion.role.node.defaultChild as iam.CfnRole).roleName = common.getResourceName(`${serviceName}-bastion-role`);

    // Allow bastion host connect to database
    dbCluster.connections.allowDefaultPortFrom(bastion, "Allow bastion host connect to database");
  }
}
