import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { config } from "./config.js";
import { utils } from "./utils.js";

const s3 = new S3Client({
  region: config.storageRegion,
  endpoint: config.storageEndpoint,
  credentials: {
    accessKeyId: config.storageAccessKey,
    secretAccessKey: config.storageSecretKey,
  },
});

export async function uploadVideoObject(params: {
  objectKey: string;
  body: Buffer;
}) {
  const startedAt = Date.now();
  console.log({
    ts: new Date().toISOString(),
    level: "info",
    event: "video_export.upload_started",
    objectKey: params.objectKey,
    bytes: params.body.byteLength,
    bucket: config.storageBucket,
  });

  await s3.send(
    new PutObjectCommand({
      Bucket: config.storageBucket,
      Key: params.objectKey,
      Body: params.body,
      ContentType: "video/mp4",
    }),
  );

  console.log({
    ts: new Date().toISOString(),
    level: "info",
    event: "video_export.upload_completed",
    objectKey: params.objectKey,
    bytes: params.body.byteLength,
    durationSec: utils.seconds(Date.now() - startedAt),
  });
}
