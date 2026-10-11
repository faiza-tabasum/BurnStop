// Thin wrappers over AWS services. Each throws on failure; callers decide the fallback.
// The AWS SDK v3 is already included in the Lambda nodejs22.x runtime, so nothing to install.
const LOCAL = process.env.LOCAL === '1';
const region = process.env.AWS_REGION || 'ap-south-1';

// Amazon Polly: Hindi voice "Aditi" (standard engine). There is no Punjabi voice, so audio is Hindi only.
export async function speakHindi(text) {
  if (LOCAL) throw new Error('local mode: Polly skipped');
  const { PollyClient, SynthesizeSpeechCommand } = await import('@aws-sdk/client-polly');
  const r = await new PollyClient({ region }).send(new SynthesizeSpeechCommand({
    Text: text, OutputFormat: 'mp3', VoiceId: 'Aditi', Engine: 'standard', LanguageCode: 'hi-IN',
  }));
  return Buffer.from(await r.AudioStream.transformToByteArray());
}

// Amazon SNS: email escalation to the officer.
export async function notifyOfficer(subject, message) {
  if (LOCAL || !process.env.TOPIC_ARN) { console.log('[SNS skipped]', subject); return { skipped: true }; }
  const { SNSClient, PublishCommand } = await import('@aws-sdk/client-sns');
  await new SNSClient({ region }).send(new PublishCommand({
    TopicArn: process.env.TOPIC_ARN, Subject: subject.slice(0, 99), Message: message,
  }));
  return { sent: true };
}

// Amazon Bedrock (optional, off unless USE_BEDROCK=1): one-paragraph officer briefing.
export async function bedrockBrief(prompt) {
  if (LOCAL || process.env.USE_BEDROCK !== '1') return null;
  const { BedrockRuntimeClient, ConverseCommand } = await import('@aws-sdk/client-bedrock-runtime');
  const r = await new BedrockRuntimeClient({ region }).send(new ConverseCommand({
    modelId: process.env.BEDROCK_MODEL || 'amazon.nova-micro-v1:0',
    messages: [{ role: 'user', content: [{ text: prompt }] }],
    inferenceConfig: { maxTokens: 180, temperature: 0.2 },
  }));
  return r.output?.message?.content?.[0]?.text || null;
}
