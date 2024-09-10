import { join } from "node:path";
import { COMPOSE_PATH } from "@/server/constants";
import { db } from "@/server/db";
import { type apiCreateCompose, compose } from "@/server/db/schema";
import { generateAppName } from "@/server/db/schema/utils";
import {
	buildCompose,
	getBuildComposeCommand,
} from "@/server/utils/builders/compose";
import { randomizeSpecificationFile } from "@/server/utils/docker/compose";
import {
	cloneCompose,
	cloneComposeRemote,
	loadDockerCompose,
	loadDockerComposeRemote,
} from "@/server/utils/docker/domain";
import { sendBuildErrorNotifications } from "@/server/utils/notifications/build-error";
import { sendBuildSuccessNotifications } from "@/server/utils/notifications/build-success";
import { execAsync, execAsyncRemote } from "@/server/utils/process/execAsync";
import {
	cloneBitbucketRepository,
	getBitbucketCloneCommand,
} from "@/server/utils/providers/bitbucket";
import {
	cloneGitRepository,
	getCustomGitCloneCommand,
} from "@/server/utils/providers/git";
import {
	cloneGithubRepository,
	getGithubCloneCommand,
} from "@/server/utils/providers/github";
import {
	cloneGitlabRepository,
	getGitlabCloneCommand,
} from "@/server/utils/providers/gitlab";
import {
	createComposeFile,
	getCreateComposeFileCommand,
} from "@/server/utils/providers/raw";
import { generatePassword } from "@/templates/utils";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { getDokployUrl } from "./admin";
import { createDeploymentCompose, updateDeploymentStatus } from "./deployment";
import { validUniqueServerAppName } from "./project";
import { executeCommand } from "@/server/utils/servers/command";
import type { ComposeSpecification } from "@/server/utils/docker/types";

export type Compose = typeof compose.$inferSelect;

export const createCompose = async (input: typeof apiCreateCompose._type) => {
	input.appName =
		`${input.appName}-${generatePassword(6)}` || generateAppName("compose");
	if (input.appName) {
		const valid = await validUniqueServerAppName(input.appName);

		if (!valid) {
			throw new TRPCError({
				code: "CONFLICT",
				message: "Service with this 'AppName' already exists",
			});
		}
	}
	const newDestination = await db
		.insert(compose)
		.values({
			...input,
			composeFile: "",
		})
		.returning()
		.then((value) => value[0]);

	if (!newDestination) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error input: Inserting compose",
		});
	}

	return newDestination;
};

export const createComposeByTemplate = async (
	input: typeof compose.$inferInsert,
) => {
	if (input.appName) {
		const valid = await validUniqueServerAppName(input.appName);

		if (!valid) {
			throw new TRPCError({
				code: "CONFLICT",
				message: "Service with this 'AppName' already exists",
			});
		}
	}
	const newDestination = await db
		.insert(compose)
		.values({
			...input,
		})
		.returning()
		.then((value) => value[0]);

	if (!newDestination) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error input: Inserting compose",
		});
	}

	return newDestination;
};

export const findComposeById = async (composeId: string) => {
	const result = await db.query.compose.findFirst({
		where: eq(compose.composeId, composeId),
		with: {
			project: true,
			deployments: true,
			mounts: true,
			domains: true,
			github: true,
			gitlab: true,
			bitbucket: true,
			server: true,
		},
	});
	if (!result) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Compose not found",
		});
	}
	return result;
};

export const loadServices = async (
	composeId: string,
	type: "fetch" | "cache" = "fetch",
) => {
	const compose = await findComposeById(composeId);

	if (type === "fetch") {
		if (compose.serverId) {
			await cloneComposeRemote(compose);
		} else {
			await cloneCompose(compose);
		}
	}

	let composeData: ComposeSpecification | null;

	if (compose.serverId) {
		composeData = await loadDockerComposeRemote(compose);
	} else {
		composeData = await loadDockerCompose(compose);
	}

	if (compose.randomize && composeData) {
		const randomizedCompose = randomizeSpecificationFile(
			composeData,
			compose.suffix,
		);
		composeData = randomizedCompose;
	}

	if (!composeData?.services) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Services not found",
		});
	}

	const services = Object.keys(composeData.services);

	return [...services];
};

export const updateCompose = async (
	composeId: string,
	composeData: Partial<Compose>,
) => {
	const composeResult = await db
		.update(compose)
		.set({
			...composeData,
		})
		.where(eq(compose.composeId, composeId))
		.returning();

	return composeResult[0];
};

export const deployCompose = async ({
	composeId,
	titleLog = "Manual deployment",
	descriptionLog = "",
}: {
	composeId: string;
	titleLog: string;
	descriptionLog: string;
}) => {
	const compose = await findComposeById(composeId);
	const buildLink = `${await getDokployUrl()}/dashboard/project/${compose.projectId}/services/compose/${compose.composeId}?tab=deployments`;
	const deployment = await createDeploymentCompose({
		composeId: composeId,
		title: titleLog,
		description: descriptionLog,
	});

	try {
		if (compose.serverId) {
			let command = `
			set -e;
			`;
			if (compose.sourceType === "github") {
				command += await getGithubCloneCommand(
					compose,
					deployment.logPath,
					true,
				);
			} else if (compose.sourceType === "gitlab") {
				command += await getGitlabCloneCommand(
					compose,
					deployment.logPath,
					true,
				);
			} else if (compose.sourceType === "bitbucket") {
				command += await getBitbucketCloneCommand(
					compose,
					deployment.logPath,
					true,
				);
			} else if (compose.sourceType === "git") {
				command += await getCustomGitCloneCommand(
					compose,
					deployment.logPath,
					true,
				);
			} else if (compose.sourceType === "raw") {
				command += getCreateComposeFileCommand(compose);
			}

			// await executeCommand(compose.serverId, command);
			command += await getBuildComposeCommand(compose, deployment.logPath);

			console.log(command);

			// console.log(buildCommand);
			try {
				const { stderr, stdout } = await execAsyncRemote(
					compose.serverId,
					command,
				);
				console.log(stderr);
				console.log(stdout);
			} catch (error) {
				console.log(error);
			}
		} else {
			if (compose.sourceType === "github") {
				await cloneGithubRepository(compose, deployment.logPath, true);
			} else if (compose.sourceType === "gitlab") {
				await cloneGitlabRepository(compose, deployment.logPath, true);
			} else if (compose.sourceType === "bitbucket") {
				await cloneBitbucketRepository(compose, deployment.logPath, true);
			} else if (compose.sourceType === "git") {
				await cloneGitRepository(compose, deployment.logPath, true);
			} else if (compose.sourceType === "raw") {
				await createComposeFile(compose, deployment.logPath);
			}

			await buildCompose(compose, deployment.logPath);
		}

		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateCompose(composeId, {
			composeStatus: "done",
		});

		await sendBuildSuccessNotifications({
			projectName: compose.project.name,
			applicationName: compose.name,
			applicationType: "compose",
			buildLink,
		});
	} catch (error) {
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updateCompose(composeId, {
			composeStatus: "error",
		});
		await sendBuildErrorNotifications({
			projectName: compose.project.name,
			applicationName: compose.name,
			applicationType: "compose",
			// @ts-ignore
			errorMessage: error?.message || "Error to build",
			buildLink,
		});
		throw error;
	}
};

export const rebuildCompose = async ({
	composeId,
	titleLog = "Rebuild deployment",
	descriptionLog = "",
}: {
	composeId: string;
	titleLog: string;
	descriptionLog: string;
}) => {
	const compose = await findComposeById(composeId);
	const deployment = await createDeploymentCompose({
		composeId: composeId,
		title: titleLog,
		description: descriptionLog,
	});

	try {
		await buildCompose(compose, deployment.logPath);
		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateCompose(composeId, {
			composeStatus: "done",
		});
	} catch (error) {
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updateCompose(composeId, {
			composeStatus: "error",
		});
		throw error;
	}

	return true;
};

export const removeCompose = async (compose: Compose) => {
	try {
		const projectPath = join(COMPOSE_PATH, compose.appName);

		if (compose.composeType === "stack") {
			await execAsync(`docker stack rm ${compose.appName}`, {
				cwd: projectPath,
			});
		} else {
			await execAsync(`docker compose -p ${compose.appName} down`, {
				cwd: projectPath,
			});
		}
	} catch (error) {
		throw error;
	}

	return true;
};

export const stopCompose = async (composeId: string) => {
	const compose = await findComposeById(composeId);
	try {
		if (compose.composeType === "docker-compose") {
			await execAsync(`docker compose -p ${compose.appName} stop`, {
				cwd: join(COMPOSE_PATH, compose.appName),
			});
		}

		await updateCompose(composeId, {
			composeStatus: "idle",
		});
	} catch (error) {
		await updateCompose(composeId, {
			composeStatus: "error",
		});
		throw error;
	}

	return true;
};
