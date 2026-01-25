import type { Logger } from '../logging/logger';
import type { Mailer } from './mailer';

interface PostmarkConfig {
  apiKey: string;
  from: string;
  replyTo?: string;
  baseUrl?: string;
}

export class PostmarkMailer implements Mailer {
  private readonly apiKey: string;
  private readonly from: string;
  private readonly replyTo?: string;
  private readonly baseUrl: string;
  private readonly logger: Logger;

  constructor(config: PostmarkConfig, logger: Logger) {
    this.apiKey = config.apiKey;
    this.from = config.from;
    this.replyTo = config.replyTo;
    this.baseUrl = config.baseUrl ?? 'https://api.postmarkapp.com';
    this.logger = logger;
  }

  async sendEmailVerification(email: string, link: string): Promise<void> {
    await this.sendEmail({
      to: email,
      subject: 'Verify your email',
      textBody: `Verify your email by visiting: ${link}`,
    });
  }

  async sendPasswordReset(email: string, link: string): Promise<void> {
    await this.sendEmail({
      to: email,
      subject: 'Reset your password',
      textBody: `Reset your password by visiting: ${link}`,
    });
  }

  private async sendEmail(params: { to: string; subject: string; textBody: string }): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(`${this.baseUrl}/email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Postmark-Server-Token': this.apiKey,
        },
        body: JSON.stringify({
          From: this.from,
          To: params.to,
          Subject: params.subject,
          TextBody: params.textBody,
          ...(this.replyTo ? { ReplyTo: this.replyTo } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        this.logger.error('Postmark email send failed', {
          status: response.status,
          body,
          to: params.to,
        });
        throw new Error(`Postmark email failed with status ${response.status}`);
      }
    } catch (error) {
      this.logger.error('Postmark email send error', {
        error: error instanceof Error ? error.message : String(error),
        to: params.to,
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
