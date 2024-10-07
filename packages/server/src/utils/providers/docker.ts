import { createWriteStream } from "node:fs";
import { type ApplicationNested, mechanizeDockerContainer } from "../builders";
import { pullImage } from "../docker/utils";

interface RegistryAuth {
	username: string;
	password: string;
	serveraddress: string;
}

export const buildDocker = async (
	application: ApplicationNested,
	logPath: string,
): Promise<void> => {
	const { buildType, dockerImage, username, password } = application;
	const authConfig: Partial<RegistryAuth> = {
		username: username || "",
		password: password || "",
	};

	const writeStream = createWriteStream(logPath, { flags: "a" });

	writeStream.write(`\nBuild ${buildType}\n`);

	writeStream.write(`Pulling ${dockerImage}: ✅\n`);

	try {
		if (!dockerImage) {
			throw new Error("Docker image not found");
		}

		await pullImage(
			dockerImage,
			(data) => {
				if (writeStream.writable) {
					writeStream.write(`${data.status}\n`);
				}
			},
			authConfig,
		);
		await mechanizeDockerContainer(application);
		writeStream.write("\nDocker Deployed: ✅\n");
	} catch (error) {
		writeStream.write(`ERROR: ${error}: ❌`);
		throw error;
	} finally {
		writeStream.end();
	}
};

export const buildRemoteDocker = async (
	application: ApplicationNested,
	logPath: string,
) => {
	const { sourceType, dockerImage, username, password } = application;

	try {
		if (!dockerImage) {
			throw new Error("Docker image not found");
		}
		let command = `
echo "Pulling ${dockerImage}" >> ${logPath};		
		`;

		if (username && password) {
			command += `
if ! docker login --username ${username} --password ${password} https://index.docker.io/v1/ >> ${logPath} 2>&1; then
	echo "❌ Login failed" >> ${logPath};
	exit 1;
fi
`;
		}

		command += `
docker pull ${dockerImage} >> ${logPath} 2>> ${logPath} || { 
  echo "❌ Pulling image failed" >> ${logPath};
  exit 1;
}

echo "✅ Pulling image completed." >> ${logPath};
`;
		return command;
	} catch (error) {
		throw error;
	}
};