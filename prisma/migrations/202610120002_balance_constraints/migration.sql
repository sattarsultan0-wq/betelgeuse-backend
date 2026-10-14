ALTER TABLE "User" ADD CONSTRAINT "User_generationCredits_nonnegative" CHECK ("generationCredits" >= 0);
ALTER TABLE "Generation" ADD CONSTRAINT "Generation_quotaCost_positive" CHECK ("quotaCost" > 0);
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_price_nonnegative" CHECK ("price" IS NULL OR "price" >= 0);
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_generationLimit_nonnegative" CHECK ("generationLimit" IS NULL OR "generationLimit" >= 0);
