import { IsEmail, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { RejectObjectCoercion } from './register.dto.js';

export class LoginDto {
  @ApiProperty({ example: 'dev@example.com' })
  @IsEmail()
  email: string;

  /**
   * The same object-coercion hole RegisterDto had: with
   * `enableImplicitConversion` on, a JSON object sent as `password` reaches
   * @IsString already flattened to the literal "[object Object]".
   *
   * Not exploitable on this route today — bcrypt.compare against a real hash
   * cannot match a fifteen-character constant — but leaving it here made the
   * two DTOs disagree about what a password is, and the day any code looks at
   * the value before hashing it (a re-auth check, a "same as current password"
   * comparison) the disagreement becomes the bug. Refused at the door instead.
   *
   * A number still coerces to a string, exactly as it does on registration.
   * That has to stay symmetrical: everyone who signed up with
   * `password: 12345678` logs in by sending the same number back.
   */
  @ApiProperty({ example: 'securePassword123' })
  @RejectObjectCoercion()
  @IsString()
  password: string;
}
