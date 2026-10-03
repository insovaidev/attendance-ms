// Re-publishes messages from a dead-letter topic to the topics they came from.
//   npm run kafka:redrive                 # notification.dlq
//   npm run kafka:redrive -- stats        # stats.dlq
//
// Fix whatever made them fail first (Telegram token, a bug...), then run it.
// The messages go back to the ORIGINAL topic, so every consumer group sees
// them again; that's fine because consumers ignore eventIds they already handled.
// The redrive has its own consumer group, so a message is only redriven once.
// Messages marked x-permanent (bad signature, not JSON) are skipped: sending
// them back would only put them in the DLQ again.
import kafkajs from 'kafkajs';

const { Kafka, Partitioners, logLevel } = kafkajs;
const group = process.argv[2] ?? 'notification';
const dlq = `${group}.dlq`;
const DROP = new Set(['x-error', 'x-permanent', 'x-original-topic', 'x-original-partition', 'x-original-offset']);

const kafka = new Kafka({
  clientId: 'redrive',
  brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(','),
  logLevel: logLevel.WARN,
});
const groupId = `${dlq}-redrive`;

// Where are we, and where does the topic end? Stop once we reach the end.
const admin = kafka.admin();
await admin.connect();
const ends = await admin.fetchTopicOffsets(dlq);
const [committed] = await admin.fetchOffsets({ groupId, topics: [dlq] });
await admin.disconnect();

const remaining = new Map();
for (const { partition, high, low } of ends) {
  const start = Number(committed.partitions.find((p) => p.partition === partition)?.offset ?? -1);
  const from = start >= 0 ? start : Number(low);
  if (from < Number(high)) remaining.set(partition, Number(high) - 1); // last offset to process
}
if (remaining.size === 0) {
  console.log(`${dlq} is empty (or already redriven). Nothing to do.`);
  process.exit(0);
}

const producer = kafka.producer({ createPartitioner: Partitioners.DefaultPartitioner });
const consumer = kafka.consumer({ groupId });
await Promise.all([producer.connect(), consumer.connect()]);
await consumer.subscribe({ topic: dlq, fromBeginning: true });

let count = 0;
let skipped = 0;
const done = new Promise((resolve) => {
  consumer.run({
    eachMessage: async ({ partition, message }) => {
      const headers = Object.fromEntries(
        Object.entries(message.headers ?? {}).filter(([name]) => !DROP.has(name)),
      );
      const topic = String(message.headers['x-original-topic']);
      if (String(message.headers['x-permanent']) === 'true') {
        console.log(`✗ skipped ${topic}@${message.headers['x-original-offset']}  (${message.headers['x-error']})`);
        skipped++;
      } else {
        console.log(`→ ${topic}  (failed with: ${message.headers['x-error']})`);
        await producer.send({ topic, messages: [{ key: message.key, value: message.value, headers }] });
        count++;
      }
      await consumer.commitOffsets([{ topic: dlq, partition, offset: String(Number(message.offset) + 1) }]);
      if (Number(message.offset) >= remaining.get(partition)) remaining.delete(partition);
      if (remaining.size === 0) resolve();
    },
  });
});

await done;
await consumer.disconnect();
await producer.disconnect();
console.log(`Redrove ${count} message(s) from ${dlq}, skipped ${skipped} that can never succeed.`);
