ALTER TABLE "User" ADD COLUMN "isAdmin" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Generation" DROP CONSTRAINT "Generation_quotaCost_positive";
ALTER TABLE "Generation" ADD CONSTRAINT "Generation_quotaCost_nonnegative" CHECK ("quotaCost" >= 0);
