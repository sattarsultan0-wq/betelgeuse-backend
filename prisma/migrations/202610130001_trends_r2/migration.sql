ALTER TYPE "GenerationMode" ADD VALUE 'REFERENCE_TO_VIDEO';
ALTER TABLE "Generation" ADD COLUMN "trendId" TEXT,
  ADD COLUMN "sourceImageIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  ADD COLUMN "submissionAttemptedAt" TIMESTAMP(3),
  ADD COLUMN "resultVideoKey" TEXT;
ALTER TABLE "StoredImage" ADD COLUMN "storageKind" TEXT NOT NULL DEFAULT 'local';
CREATE TABLE "DirectUpload" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "trendId" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "imageId" UUID,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DirectUpload_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DirectUpload_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DirectUpload_objectKey_key" ON "DirectUpload"("objectKey");
CREATE INDEX "DirectUpload_userId_createdAt_idx" ON "DirectUpload"("userId", "createdAt");
