import type { Logger } from '../logging/logger';

export interface Mailer {
  sendEmailVerification(email: string, link: string): Promise<void>;
  sendPasswordReset(email: string, link: string): Promise<void>;
}

export class ConsoleMailer implements Mailer {
  constructor(private readonly logger: Logger) {}

  async sendEmailVerification(email: string, link: string): Promise<void> {
    this.logger.info('Email verification requested', {
      email,
      verification_link: link,
    });
  }

  async sendPasswordReset(email: string, link: string): Promise<void> {
    this.logger.info('Password reset requested', {
      email,
      reset_link: link,
    });
  }
}
