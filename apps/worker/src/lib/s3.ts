import { DeleteObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { env } from '../config.js';

let client: S3Client | null = null;

export function getS3Client(): S3Client {
  if (!client) {
    client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    });
  }
  return client;
}

/** Список ключей под префиксом старше указанного момента — для очистки брошенных загрузок. */
export async function listObjectsOlderThan(prefix: string, olderThan: Date): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const res = await getS3Client().send(
      new ListObjectsV2Command({ Bucket: env.S3_BUCKET, Prefix: prefix, ContinuationToken: continuationToken })
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key && obj.LastModified && obj.LastModified < olderThan) {
        keys.push(obj.Key);
      }
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

export async function deleteObject(key: string): Promise<void> {
  await getS3Client().send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
}
