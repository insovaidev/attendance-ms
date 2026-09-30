import { Body, Controller, Get, Inject, Put, Query } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { NOTIFICATION_PATTERNS, SERVICES, type AuthUser } from '#common';
import { CurrentUser, Roles } from '../auth/decorators.js';
import { LimitQueryDto, LinkTelegramDto } from '../dto.js';
import { call } from '../rpc.js';

@Controller('notifications')
export class NotificationsController {
  constructor(@Inject(SERVICES.NOTIFICATION) private readonly notification: ClientProxy) {}

  /** Link your Telegram chat so check-in alerts reach you. */
  @Put('telegram')
  link(@CurrentUser() user: AuthUser, @Body() dto: LinkTelegramDto) {
    return call(this.notification, NOTIFICATION_PATTERNS.LINK_TELEGRAM, { userId: user.id, chatId: dto.chatId });
  }

  @Roles('ADMIN')
  @Get('log')
  log(@Query() query: LimitQueryDto) {
    return call(this.notification, NOTIFICATION_PATTERNS.LIST_LOG, { limit: query.limit });
  }
}
