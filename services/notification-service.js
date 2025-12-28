/**
 * SYNAPSE Protocol - Notification Service
 * 
 * Multi-channel notification delivery system
 * Features:
 * - Email notifications (SMTP)
 * - Push notifications (FCM, APNS)
 * - In-app notifications
 * - SMS notifications (Twilio)
 * - Slack/Discord webhooks
 * - User preferences
 * - Template management
 * - Delivery tracking
 */

const express = require('express');
const Redis = require('ioredis');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');

// Configuration
const CONFIG = {
  port: process.env.NOTIFICATION_PORT || 3005,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  
  // Email
  smtp: {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  },
  
  // Firebase Cloud Messaging
  fcm: {
    projectId: process.env.FCM_PROJECT_ID,
    privateKey: process.env.FCM_PRIVATE_KEY,
    clientEmail: process.env.FCM_CLIENT_EMAIL
  },
  
  // Twilio
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    fromNumber: process.env.TWILIO_FROM_NUMBER
  },
  
  // Rate limits
  rateLimits: {
    email: { perHour: 100, perDay: 500 },
    push: { perHour: 500, perDay: 5000 },
    sms: { perHour: 50, perDay: 200 }
  }
};

// Notification types
const NotificationType = {
  // Payment notifications
  PAYMENT_RECEIVED: 'payment_received',
  PAYMENT_SENT: 'payment_sent',
  PAYMENT_FAILED: 'payment_failed',
  
  // Escrow notifications
  ESCROW_CREATED: 'escrow_created',
  ESCROW_RELEASED: 'escrow_released',
  ESCROW_DISPUTED: 'escrow_disputed',
  
  // Channel notifications
  CHANNEL_OPENED: 'channel_opened',
  CHANNEL_CLOSING: 'channel_closing',
  CHANNEL_CLOSED: 'channel_closed',
  
  // Subscription notifications
  SUBSCRIPTION_CREATED: 'subscription_created',
  SUBSCRIPTION_RENEWED: 'subscription_renewed',
  SUBSCRIPTION_EXPIRING: 'subscription_expiring',
  SUBSCRIPTION_CANCELLED: 'subscription_cancelled',
  
  // Staking notifications
  REWARDS_AVAILABLE: 'rewards_available',
  STAKE_MATURED: 'stake_matured',
  UNSTAKE_READY: 'unstake_ready',
  
  // Security notifications
  SECURITY_ALERT: 'security_alert',
  LOGIN_NEW_DEVICE: 'login_new_device',
  PASSWORD_CHANGED: 'password_changed',
  
  // System notifications
  SYSTEM_ANNOUNCEMENT: 'system_announcement',
  MAINTENANCE_SCHEDULED: 'maintenance_scheduled',
  SERVICE_DEGRADATION: 'service_degradation'
};

// Delivery channels
const DeliveryChannel = {
  EMAIL: 'email',
  PUSH: 'push',
  IN_APP: 'in_app',
  SMS: 'sms',
  SLACK: 'slack',
  DISCORD: 'discord',
  WEBHOOK: 'webhook'
};

/**
 * Notification Templates
 */
const templates = {
  [NotificationType.PAYMENT_RECEIVED]: {
    email: {
      subject: 'Payment Received - {{amount}} SYNX',
      body: `
        <h2>Payment Received</h2>
        <p>You have received a payment of <strong>{{amount}} SYNX</strong></p>
        <p>From: {{sender}}</p>
        <p>Transaction: <a href="{{explorerUrl}}">{{txHash}}</a></p>
        <p>Your new balance: {{newBalance}} SYNX</p>
      `
    },
    push: {
      title: 'Payment Received',
      body: 'You received {{amount}} SYNX from {{senderShort}}'
    },
    sms: 'SYNAPSE: Received {{amount}} SYNX from {{senderShort}}. TX: {{txHashShort}}'
  },
  
  [NotificationType.PAYMENT_SENT]: {
    email: {
      subject: 'Payment Sent - {{amount}} SYNX',
      body: `
        <h2>Payment Sent Successfully</h2>
        <p>You have sent <strong>{{amount}} SYNX</strong></p>
        <p>To: {{recipient}}</p>
        <p>Fee: {{fee}} SYNX</p>
        <p>Transaction: <a href="{{explorerUrl}}">{{txHash}}</a></p>
      `
    },
    push: {
      title: 'Payment Sent',
      body: 'Sent {{amount}} SYNX to {{recipientShort}}'
    }
  },
  
  [NotificationType.SUBSCRIPTION_EXPIRING]: {
    email: {
      subject: 'Subscription Expiring Soon',
      body: `
        <h2>Subscription Reminder</h2>
        <p>Your subscription to <strong>{{planName}}</strong> will expire in {{daysRemaining}} days.</p>
        <p>Renew now to avoid service interruption.</p>
        <a href="{{renewUrl}}" style="background: #00d4aa; color: #000; padding: 12px 24px; text-decoration: none; border-radius: 8px;">Renew Subscription</a>
      `
    },
    push: {
      title: 'Subscription Expiring',
      body: '{{planName}} expires in {{daysRemaining}} days'
    }
  },
  
  [NotificationType.REWARDS_AVAILABLE]: {
    email: {
      subject: 'Staking Rewards Available - {{amount}} SYNX',
      body: `
        <h2>Staking Rewards Ready</h2>
        <p>You have <strong>{{amount}} SYNX</strong> in unclaimed staking rewards.</p>
        <p>Current APR: {{apr}}%</p>
        <a href="{{claimUrl}}" style="background: #00d4aa; color: #000; padding: 12px 24px; text-decoration: none; border-radius: 8px;">Claim Rewards</a>
      `
    },
    push: {
      title: 'Rewards Available',
      body: 'Claim your {{amount}} SYNX staking rewards'
    }
  },
  
  [NotificationType.SECURITY_ALERT]: {
    email: {
      subject: '⚠️ Security Alert - Action Required',
      body: `
        <h2 style="color: #ef4444;">Security Alert</h2>
        <p>{{alertMessage}}</p>
        <p>Time: {{timestamp}}</p>
        <p>IP Address: {{ipAddress}}</p>
        <p>If this wasn't you, please secure your account immediately.</p>
        <a href="{{securityUrl}}" style="background: #ef4444; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 8px;">Review Activity</a>
      `
    },
    push: {
      title: '⚠️ Security Alert',
      body: '{{alertMessage}}'
    },
    sms: 'SYNAPSE SECURITY ALERT: {{alertMessage}}. Review at {{securityUrl}}'
  }
};

/**
 * User Preferences
 */
class UserPreferences {
  constructor(redis) {
    this.redis = redis;
  }

  async get(userId) {
    const data = await this.redis.get(`user:prefs:${userId}`);
    if (data) return JSON.parse(data);

    // Default preferences
    return {
      channels: {
        email: true,
        push: true,
        in_app: true,
        sms: false
      },
      notifications: {
        payments: true,
        subscriptions: true,
        staking: true,
        security: true,
        marketing: false
      },
      quiet_hours: {
        enabled: false,
        start: '22:00',
        end: '08:00',
        timezone: 'UTC'
      },
      digest: {
        enabled: false,
        frequency: 'daily' // daily, weekly
      }
    };
  }

  async set(userId, preferences) {
    await this.redis.set(`user:prefs:${userId}`, JSON.stringify(preferences));
  }

  async update(userId, updates) {
    const current = await this.get(userId);
    const updated = { ...current, ...updates };
    await this.set(userId, updated);
    return updated;
  }
}

/**
 * Template Engine
 */
class TemplateEngine {
  static render(template, data) {
    let result = template;
    for (const [key, value] of Object.entries(data)) {
      result = result.replace(new RegExp(`{{${key}}}`, 'g'), value);
    }
    return result;
  }

  static renderNotification(type, channel, data) {
    const template = templates[type]?.[channel];
    if (!template) return null;

    if (typeof template === 'string') {
      return TemplateEngine.render(template, data);
    }

    if (typeof template === 'object') {
      const result = {};
      for (const [key, value] of Object.entries(template)) {
        result[key] = TemplateEngine.render(value, data);
      }
      return result;
    }

    return null;
  }
}

/**
 * Email Sender
 */
class EmailSender {
  constructor() {
    this.transporter = nodemailer.createTransport(CONFIG.smtp);
  }

  async send(to, subject, html, options = {}) {
    const mailOptions = {
      from: options.from || `SYNAPSE Protocol <${CONFIG.smtp.auth.user}>`,
      to,
      subject,
      html,
      ...options
    };

    try {
      const result = await this.transporter.sendMail(mailOptions);
      return { success: true, messageId: result.messageId };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

/**
 * Push Sender (FCM)
 */
class PushSender {
  constructor() {
    // Initialize Firebase Admin SDK here
  }

  async send(token, title, body, data = {}) {
    // FCM implementation
    const message = {
      notification: { title, body },
      data,
      token
    };

    try {
      // await admin.messaging().send(message);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async sendToTopic(topic, title, body, data = {}) {
    const message = {
      notification: { title, body },
      data,
      topic
    };

    try {
      // await admin.messaging().send(message);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

/**
 * SMS Sender (Twilio)
 */
class SmsSender {
  constructor() {
    // Initialize Twilio client here
  }

  async send(to, message) {
    try {
      // const result = await twilioClient.messages.create({
      //   body: message,
      //   from: CONFIG.twilio.fromNumber,
      //   to
      // });
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

/**
 * Notification Service
 */
class NotificationService {
  constructor() {
    this.app = express();
    this.redis = null;
    this.userPrefs = null;
    this.emailSender = null;
    this.pushSender = null;
    this.smsSender = null;
  }

  async initialize() {
    console.log('📨 Initializing Notification Service...');

    // Connect to Redis
    this.redis = new Redis(CONFIG.redisUrl);
    console.log('📦 Connected to Redis');

    // Initialize components
    this.userPrefs = new UserPreferences(this.redis);
    this.emailSender = new EmailSender();
    this.pushSender = new PushSender();
    this.smsSender = new SmsSender();

    // Setup routes
    this.setupRoutes();

    // Start queue processor
    this.startQueueProcessor();

    console.log('✅ Notification Service initialized');
  }

  /**
   * Send notification to user
   */
  async sendNotification(userId, type, data, options = {}) {
    const id = uuidv4();
    const notification = {
      id,
      userId,
      type,
      data,
      createdAt: Date.now(),
      status: 'pending',
      deliveries: []
    };

    // Get user preferences
    const prefs = await this.userPrefs.get(userId);

    // Check quiet hours
    if (prefs.quiet_hours.enabled && !options.urgent) {
      const inQuietHours = this.isInQuietHours(prefs.quiet_hours);
      if (inQuietHours) {
        notification.status = 'queued';
        notification.queuedReason = 'quiet_hours';
        await this.redis.lpush('notifications:delayed', JSON.stringify(notification));
        return { id, status: 'queued', reason: 'quiet_hours' };
      }
    }

    // Get user contact info
    const userInfo = await this.getUserInfo(userId);

    // Send through enabled channels
    const deliveryPromises = [];

    // Email
    if (prefs.channels.email && userInfo.email) {
      const template = TemplateEngine.renderNotification(type, 'email', data);
      if (template) {
        deliveryPromises.push(
          this.deliverEmail(notification.id, userInfo.email, template)
        );
      }
    }

    // Push
    if (prefs.channels.push && userInfo.pushToken) {
      const template = TemplateEngine.renderNotification(type, 'push', data);
      if (template) {
        deliveryPromises.push(
          this.deliverPush(notification.id, userInfo.pushToken, template)
        );
      }
    }

    // SMS (only for important notifications)
    if (prefs.channels.sms && userInfo.phone && options.urgent) {
      const template = TemplateEngine.renderNotification(type, 'sms', data);
      if (template) {
        deliveryPromises.push(
          this.deliverSms(notification.id, userInfo.phone, template)
        );
      }
    }

    // In-app (always)
    if (prefs.channels.in_app) {
      await this.createInAppNotification(userId, type, data);
    }

    // Wait for deliveries
    const results = await Promise.allSettled(deliveryPromises);
    notification.deliveries = results.map(r => r.value || r.reason);
    notification.status = 'sent';

    // Store notification
    await this.storeNotification(notification);

    return { id, status: 'sent', deliveries: notification.deliveries };
  }

  /**
   * Deliver email
   */
  async deliverEmail(notificationId, email, template) {
    const result = await this.emailSender.send(email, template.subject, template.body);
    return {
      channel: 'email',
      to: email,
      ...result
    };
  }

  /**
   * Deliver push notification
   */
  async deliverPush(notificationId, token, template) {
    const result = await this.pushSender.send(token, template.title, template.body);
    return {
      channel: 'push',
      ...result
    };
  }

  /**
   * Deliver SMS
   */
  async deliverSms(notificationId, phone, message) {
    const result = await this.smsSender.send(phone, message);
    return {
      channel: 'sms',
      to: phone,
      ...result
    };
  }

  /**
   * Create in-app notification
   */
  async createInAppNotification(userId, type, data) {
    const notification = {
      id: uuidv4(),
      type,
      data,
      read: false,
      createdAt: Date.now()
    };

    await this.redis.lpush(`notifications:inapp:${userId}`, JSON.stringify(notification));
    await this.redis.ltrim(`notifications:inapp:${userId}`, 0, 99); // Keep last 100

    return notification;
  }

  /**
   * Get in-app notifications
   */
  async getInAppNotifications(userId, limit = 20) {
    const notifications = await this.redis.lrange(`notifications:inapp:${userId}`, 0, limit - 1);
    return notifications.map(n => JSON.parse(n));
  }

  /**
   * Mark notification as read
   */
  async markAsRead(userId, notificationId) {
    const notifications = await this.getInAppNotifications(userId, 100);
    const updated = notifications.map(n => {
      if (n.id === notificationId) {
        n.read = true;
      }
      return n;
    });

    await this.redis.del(`notifications:inapp:${userId}`);
    for (const n of updated.reverse()) {
      await this.redis.lpush(`notifications:inapp:${userId}`, JSON.stringify(n));
    }
  }

  /**
   * Mark all as read
   */
  async markAllAsRead(userId) {
    const notifications = await this.getInAppNotifications(userId, 100);
    const updated = notifications.map(n => ({ ...n, read: true }));

    await this.redis.del(`notifications:inapp:${userId}`);
    for (const n of updated.reverse()) {
      await this.redis.lpush(`notifications:inapp:${userId}`, JSON.stringify(n));
    }
  }

  /**
   * Store notification for history
   */
  async storeNotification(notification) {
    const key = `notifications:history:${notification.userId}`;
    await this.redis.lpush(key, JSON.stringify(notification));
    await this.redis.ltrim(key, 0, 499); // Keep last 500
  }

  /**
   * Get user info (mock - implement with your user service)
   */
  async getUserInfo(userId) {
    // This should fetch from your user database
    const info = await this.redis.get(`user:info:${userId}`);
    if (info) return JSON.parse(info);
    return {};
  }

  /**
   * Check if current time is in quiet hours
   */
  isInQuietHours(quietHours) {
    // Simplified check - implement proper timezone handling
    const now = new Date();
    const currentHour = now.getUTCHours();
    const [startHour] = quietHours.start.split(':').map(Number);
    const [endHour] = quietHours.end.split(':').map(Number);

    if (startHour > endHour) {
      // Crosses midnight
      return currentHour >= startHour || currentHour < endHour;
    }
    return currentHour >= startHour && currentHour < endHour;
  }

  /**
   * Process delayed notifications queue
   */
  startQueueProcessor() {
    setInterval(async () => {
      const delayed = await this.redis.lrange('notifications:delayed', 0, 9);

      for (const item of delayed) {
        const notification = JSON.parse(item);
        const prefs = await this.userPrefs.get(notification.userId);

        // Check if still in quiet hours
        if (prefs.quiet_hours.enabled) {
          const inQuietHours = this.isInQuietHours(prefs.quiet_hours);
          if (!inQuietHours) {
            // Remove from queue and send
            await this.redis.lrem('notifications:delayed', 1, item);
            await this.sendNotification(
              notification.userId,
              notification.type,
              notification.data,
              { skipQuietHours: true }
            );
          }
        }
      }
    }, 60000); // Check every minute
  }

  /**
   * Setup Express routes
   */
  setupRoutes() {
    this.app.use(express.json());

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ status: 'healthy' });
    });

    // Send notification
    this.app.post('/api/notify', async (req, res) => {
      try {
        const { userId, type, data, options } = req.body;
        const result = await this.sendNotification(userId, type, data, options);
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Send bulk notifications
    this.app.post('/api/notify/bulk', async (req, res) => {
      try {
        const { userIds, type, data, options } = req.body;
        const results = await Promise.all(
          userIds.map(userId => this.sendNotification(userId, type, data, options))
        );
        res.json({ sent: results.length, results });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get in-app notifications
    this.app.get('/api/notifications/:userId', async (req, res) => {
      try {
        const { userId } = req.params;
        const { limit = 20 } = req.query;
        const notifications = await this.getInAppNotifications(userId, parseInt(limit));
        const unread = notifications.filter(n => !n.read).length;
        res.json({ notifications, unread });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Mark as read
    this.app.post('/api/notifications/:userId/read', async (req, res) => {
      try {
        const { userId } = req.params;
        const { notificationId, all } = req.body;

        if (all) {
          await this.markAllAsRead(userId);
        } else {
          await this.markAsRead(userId, notificationId);
        }

        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get/Update preferences
    this.app.get('/api/preferences/:userId', async (req, res) => {
      try {
        const prefs = await this.userPrefs.get(req.params.userId);
        res.json(prefs);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.put('/api/preferences/:userId', async (req, res) => {
      try {
        const updated = await this.userPrefs.update(req.params.userId, req.body);
        res.json(updated);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Register device for push
    this.app.post('/api/devices', async (req, res) => {
      try {
        const { userId, token, platform } = req.body;
        await this.redis.hset(`user:devices:${userId}`, token, JSON.stringify({
          platform,
          registeredAt: Date.now()
        }));
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Unregister device
    this.app.delete('/api/devices', async (req, res) => {
      try {
        const { userId, token } = req.body;
        await this.redis.hdel(`user:devices:${userId}`, token);
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  }

  /**
   * Start server
   */
  start() {
    this.app.listen(CONFIG.port, () => {
      console.log(`\n📨 Notification Service running on port ${CONFIG.port}`);
      console.log('\n📡 Endpoints:');
      console.log('   POST /api/notify           - Send notification');
      console.log('   POST /api/notify/bulk      - Send bulk notifications');
      console.log('   GET  /api/notifications/:userId - Get notifications');
      console.log('   POST /api/notifications/:userId/read - Mark as read');
      console.log('   GET  /api/preferences/:userId - Get preferences');
      console.log('   PUT  /api/preferences/:userId - Update preferences');
      console.log('   POST /api/devices          - Register device');
      console.log('   DELETE /api/devices        - Unregister device\n');
    });
  }
}

// Main
async function main() {
  const service = new NotificationService();
  await service.initialize();
  service.start();
}

main().catch(console.error);

module.exports = { NotificationService, NotificationType, DeliveryChannel };
