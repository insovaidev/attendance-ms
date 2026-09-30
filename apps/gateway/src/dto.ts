import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { Role, ShiftType } from '#common';

/**
 * HTTP input validation lives at the edge (the gateway).
 * Internal services receive already-validated payloads, though they still
 * check their own business rules.
 */

export class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  @MaxLength(200)
  password: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;
}

export class CreateUserDto extends RegisterDto {
  @IsIn(['ADMIN', 'EMPLOYEE'])
  role: Role;
}

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @MaxLength(200)
  password: string;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export class CreateShiftDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name: string;

  @IsIn(['FIXED', 'ROTATING', 'REMOTE'])
  type: ShiftType;

  @Matches(HHMM, { message: 'startTime must be HH:MM (24h)' })
  startTime: string;

  @Matches(HHMM, { message: 'endTime must be HH:MM (24h)' })
  endTime: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  graceMinutes?: number;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  days?: number[];
}

export class AssignShiftDto {
  @IsUUID()
  userId: string;

  @IsDateString({ strict: true })
  startDate: string;

  @IsOptional()
  @IsDateString({ strict: true })
  endDate?: string;
}

export class CheckInDto {
  @IsOptional()
  @IsIn(['WEB', 'TELEGRAM'])
  source?: 'WEB' | 'TELEGRAM';

  @IsOptional()
  @IsString()
  @MaxLength(280)
  note?: string;
}

export class LinkTelegramDto {
  @Matches(/^-?\d+$/, { message: 'chatId must be a numeric Telegram chat id' })
  chatId: string;
}

export class DaysQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(366)
  days?: number;
}

export class DateQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}

export class LimitQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
