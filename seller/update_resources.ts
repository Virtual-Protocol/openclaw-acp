import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { upsertResourceApi, deleteResourceApi } from "../scripts/api";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function createResource(resourceName: string) {
  const resourcePath = path.join(
    __dirname,
    "resources",
    resourceName,
    "resources.json"
  );
  if (!fs.existsSync(resourcePath)) {
    console.error(`Resource not found: ${resourcePath}`);
    process.exit(1);
  }

  const resource = JSON.parse(fs.readFileSync(resourcePath, "utf-8"));
  const result = await upsertResourceApi(resource);

  if (result.success) {
    console.log(`Resource ${resourceName} created successfully`);
  } else {
    console.error(`Failed to create resource ${resourceName}`);
    process.exit(1);
  }
}

async function deleteResource(resourceName: string) {
  const result = await deleteResourceApi(resourceName);
  if (result.success) {
    console.log(`Resource ${resourceName} deleted successfully`);
  } else {
    console.error(`Failed to delete resource ${resourceName}`);
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error("Usage: npm run resource:create -- <resource-name>");
    console.error("       npm run resource:delete -- <resource-name>");
    process.exit(1);
  }

  const action = args[0];
  const resourceName = args[1];

  switch (action) {
    case "create":
      await createResource(resourceName);
      break;
    case "delete":
      await deleteResource(resourceName);
      break;
    default:
      console.error(`Unknown action: "${action}"`);
      console.error('Supported actions: "create", "delete"');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
