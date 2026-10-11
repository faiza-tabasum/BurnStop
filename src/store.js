// Tiny key-value layer. DynamoDB in AWS, a JSON file when LOCAL=1 (for testing without AWS).
// Items are stored as { pk, sk, data }.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const LOCAL = process.env.LOCAL === '1';
const TABLE = process.env.TABLE;

let ddb, cmd;
async function init() {
  if (ddb) return;
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  cmd = await import('@aws-sdk/lib-dynamodb');
  ddb = cmd.DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
}

const DB_FILE = process.env.LOCAL_DB || '/tmp/burnstop-local-db.json';
let mem = null;
const memLoad = () => (mem ||= existsSync(DB_FILE) ? JSON.parse(readFileSync(DB_FILE, 'utf8')) : {});
const memSave = () => writeFileSync(DB_FILE, JSON.stringify(mem));
const key = (pk, sk) => `${pk}||${sk}`;

export async function get(pk, sk) {
  if (LOCAL) { const v = memLoad()[key(pk, sk)]; return v ? structuredClone(v) : null; }
  await init();
  const r = await ddb.send(new cmd.GetCommand({ TableName: TABLE, Key: { pk, sk } }));
  return r.Item ? r.Item.data : null;
}

export async function put(pk, sk, data) {
  if (LOCAL) { memLoad()[key(pk, sk)] = structuredClone(data); memSave(); return; }
  await init();
  await ddb.send(new cmd.PutCommand({ TableName: TABLE, Item: { pk, sk, data } }));
}

export async function del(pk, sk) {
  if (LOCAL) { delete memLoad()[key(pk, sk)]; memSave(); return; }
  await init();
  await ddb.send(new cmd.DeleteCommand({ TableName: TABLE, Key: { pk, sk } }));
}

export async function query(pk) {
  if (LOCAL) {
    const db = memLoad();
    return Object.keys(db).filter((k) => k.startsWith(pk + '||')).sort().map((k) => structuredClone(db[k]));
  }
  await init();
  const out = [];
  let ExclusiveStartKey;
  do {
    const r = await ddb.send(new cmd.QueryCommand({
      TableName: TABLE, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': pk }, ExclusiveStartKey,
    }));
    out.push(...r.Items.map((i) => i.data));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}
