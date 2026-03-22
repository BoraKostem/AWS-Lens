import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ListQueuesCommand,
  ListQueueTagsCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
  SetQueueAttributesCommand,
  TagQueueCommand,
  UntagQueueCommand
} from '@aws-sdk/client-sqs'

import { awsClientConfig } from './client'
import type {
  AwsConnection,
  SqsMessage,
  SqsQueueSummary,
  SqsSendResult,
  SqsTimelineEvent
} from '@shared/types'

function createClient(connection: AwsConnection): SQSClient {
  return new SQSClient(awsClientConfig(connection))
}

export async function listQueues(connection: AwsConnection): Promise<SqsQueueSummary[]> {
  const client = createClient(connection)
  const queues: SqsQueueSummary[] = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new ListQueuesCommand({ NextToken: nextToken }))
    for (const url of output.QueueUrls ?? []) {
      const detail = await getQueueDetail(connection, url)
      queues.push(detail)
    }
    nextToken = output.NextToken
  } while (nextToken)

  return queues
}

export async function getQueueDetail(connection: AwsConnection, queueUrl: string): Promise<SqsQueueSummary> {
  const client = createClient(connection)
  const attrs = await client.send(new GetQueueAttributesCommand({
    QueueUrl: queueUrl,
    AttributeNames: ['All']
  }))
  const a = attrs.Attributes ?? {}

  let tags: Record<string, string> = {}
  try {
    const tagResp = await client.send(new ListQueueTagsCommand({ QueueUrl: queueUrl }))
    tags = tagResp.Tags ?? {}
  } catch { /* tags may not be accessible */ }

  let deadLetterTargetArn = ''
  let maxReceiveCount = 0
  try {
    const redrive = a.RedrivePolicy ? JSON.parse(a.RedrivePolicy) : {}
    deadLetterTargetArn = redrive.deadLetterTargetArn ?? ''
    maxReceiveCount = Number(redrive.maxReceiveCount ?? 0)
  } catch { /* ignore */ }

  return {
    queueUrl,
    queueName: queueUrl.split('/').pop() ?? '-',
    approximateMessageCount: Number(a.ApproximateNumberOfMessages ?? 0),
    approximateNotVisibleCount: Number(a.ApproximateNumberOfMessagesNotVisible ?? 0),
    approximateDelayedCount: Number(a.ApproximateNumberOfMessagesDelayed ?? 0),
    createdTimestamp: a.CreatedTimestamp ? new Date(Number(a.CreatedTimestamp) * 1000).toISOString() : '',
    lastModifiedTimestamp: a.LastModifiedTimestamp ? new Date(Number(a.LastModifiedTimestamp) * 1000).toISOString() : '',
    visibilityTimeout: Number(a.VisibilityTimeout ?? 30),
    maximumMessageSize: Number(a.MaximumMessageSize ?? 262144),
    messageRetentionPeriod: Number(a.MessageRetentionPeriod ?? 345600),
    delaySeconds: Number(a.DelaySeconds ?? 0),
    fifoQueue: a.FifoQueue === 'true',
    contentBasedDeduplication: a.ContentBasedDeduplication === 'true',
    policy: a.Policy ?? '',
    redrivePolicy: a.RedrivePolicy ?? '',
    redriveAllowPolicy: a.RedriveAllowPolicy ?? '',
    deadLetterTargetArn,
    maxReceiveCount,
    kmsMasterKeyId: a.KmsMasterKeyId ?? '',
    tags
  }
}

export async function createQueue(
  connection: AwsConnection,
  queueName: string,
  fifo: boolean,
  attributes?: Record<string, string>
): Promise<string> {
  const client = createClient(connection)
  const name = fifo && !queueName.endsWith('.fifo') ? `${queueName}.fifo` : queueName
  const attrs: Record<string, string> = { ...(attributes ?? {}) }
  if (fifo) attrs.FifoQueue = 'true'

  const output = await client.send(new CreateQueueCommand({ QueueName: name, Attributes: attrs }))
  return output.QueueUrl ?? ''
}

export async function deleteQueue(connection: AwsConnection, queueUrl: string): Promise<void> {
  const client = createClient(connection)
  await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }))
}

export async function purgeQueue(connection: AwsConnection, queueUrl: string): Promise<void> {
  const client = createClient(connection)
  await client.send(new PurgeQueueCommand({ QueueUrl: queueUrl }))
}

export async function setQueueAttributes(
  connection: AwsConnection,
  queueUrl: string,
  attributes: Record<string, string>
): Promise<void> {
  const client = createClient(connection)
  await client.send(new SetQueueAttributesCommand({ QueueUrl: queueUrl, Attributes: attributes }))
}

export async function sendMessage(
  connection: AwsConnection,
  queueUrl: string,
  body: string,
  delaySeconds?: number,
  messageGroupId?: string,
  messageDeduplicationId?: string
): Promise<SqsSendResult> {
  const client = createClient(connection)
  const output = await client.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: body,
    DelaySeconds: delaySeconds,
    MessageGroupId: messageGroupId || undefined,
    MessageDeduplicationId: messageDeduplicationId || undefined
  }))
  return {
    messageId: output.MessageId ?? '',
    md5OfBody: output.MD5OfMessageBody ?? '',
    sequenceNumber: output.SequenceNumber ?? ''
  }
}

export async function receiveMessages(
  connection: AwsConnection,
  queueUrl: string,
  maxMessages: number,
  waitTimeSeconds: number
): Promise<SqsMessage[]> {
  const client = createClient(connection)
  const output = await client.send(new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: Math.min(maxMessages, 10),
    WaitTimeSeconds: waitTimeSeconds,
    AttributeNames: ['All'],
    MessageSystemAttributeNames: ['All']
  }))

  return (output.Messages ?? []).map((m) => {
    const sysAttrs = m.Attributes ?? {}
    return {
      messageId: m.MessageId ?? '-',
      receiptHandle: m.ReceiptHandle ?? '',
      body: m.Body ?? '',
      md5OfBody: m.MD5OfBody ?? '',
      sentTimestamp: sysAttrs.SentTimestamp
        ? new Date(Number(sysAttrs.SentTimestamp)).toISOString()
        : '',
      approximateReceiveCount: Number(sysAttrs.ApproximateReceiveCount ?? 0),
      approximateFirstReceiveTimestamp: sysAttrs.ApproximateFirstReceiveTimestamp
        ? new Date(Number(sysAttrs.ApproximateFirstReceiveTimestamp)).toISOString()
        : '',
      attributes: sysAttrs,
      messageAttributes: Object.fromEntries(
        Object.entries(m.MessageAttributes ?? {}).map(([k, v]) => [k, v.StringValue ?? ''])
      )
    }
  })
}

export async function deleteMessage(
  connection: AwsConnection,
  queueUrl: string,
  receiptHandle: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }))
}

export async function changeMessageVisibility(
  connection: AwsConnection,
  queueUrl: string,
  receiptHandle: string,
  visibilityTimeout: number
): Promise<void> {
  const client = createClient(connection)
  await client.send(new ChangeMessageVisibilityCommand({
    QueueUrl: queueUrl,
    ReceiptHandle: receiptHandle,
    VisibilityTimeout: visibilityTimeout
  }))
}

export async function tagQueue(connection: AwsConnection, queueUrl: string, tags: Record<string, string>): Promise<void> {
  const client = createClient(connection)
  await client.send(new TagQueueCommand({ QueueUrl: queueUrl, Tags: tags }))
}

export async function untagQueue(connection: AwsConnection, queueUrl: string, tagKeys: string[]): Promise<void> {
  const client = createClient(connection)
  await client.send(new UntagQueueCommand({ QueueUrl: queueUrl, TagKeys: tagKeys }))
}

export function buildQueueTimeline(queue: SqsQueueSummary): SqsTimelineEvent[] {
  const events: SqsTimelineEvent[] = []
  const now = new Date().toISOString()

  if (queue.createdTimestamp) {
    events.push({ timestamp: queue.createdTimestamp, title: 'Queue Created', detail: queue.queueName, severity: 'info' })
  }
  if (queue.lastModifiedTimestamp && queue.lastModifiedTimestamp !== queue.createdTimestamp) {
    events.push({ timestamp: queue.lastModifiedTimestamp, title: 'Queue Modified', detail: 'Attributes updated', severity: 'info' })
  }
  if (queue.approximateMessageCount > 100) {
    events.push({ timestamp: now, title: 'High Message Count', detail: `${queue.approximateMessageCount} messages in queue`, severity: 'warning' })
  }
  if (queue.deadLetterTargetArn) {
    events.push({ timestamp: now, title: 'DLQ Configured', detail: `Target: ${queue.deadLetterTargetArn} (max ${queue.maxReceiveCount} receives)`, severity: 'info' })
  }
  if (queue.approximateNotVisibleCount > 0) {
    events.push({ timestamp: now, title: 'In-Flight Messages', detail: `${queue.approximateNotVisibleCount} messages currently being processed`, severity: 'info' })
  }

  return events.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
}
