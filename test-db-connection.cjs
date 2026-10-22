const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function main() {
  await prisma.$queryRawUnsafe("SELECT 1 AS ok");
  console.log("SELECT 1 PASS");
}

main()
  .catch((error) => {
    console.error(
      "SELECT 1 FAIL",
      error.name,
      error.code ?? "",
      error.message
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
