import { successResponse, errorResponse } from '@src/common/http/swagger/response.schemas';
import { userResponseSchema, loginResponseSchema } from './dto/auth-response.schema';
import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { CurrentUser, Public, RateLimit } from "@src/common/security/decorators";
import type { AccessTokenPayload } from "@src/common/security/ports";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto, LogoutDto, RefreshTokenDto } from "./dto/login.dto";
import { RegisterUserUseCase } from "../../application/use-cases/register-user.use-case";
import { LoginUseCase } from "../../application/use-cases/login.use-case";

@ApiTags('Identity')
@ApiResponse(errorResponse(400, 'VALIDATION_ERROR: dữ liệu đầu vào không hợp lệ.'))
@ApiResponse(errorResponse(500, 'INTERNAL_ERROR: lỗi nội bộ hệ thống.'))
@Controller("auth")
export class AuthController {
  constructor(
    private readonly registerUserUseCase: RegisterUserUseCase,
    private readonly loginUseCase: LoginUseCase,
  ) { }

  @ApiOperation({ summary: "Dang ky user moi" })
  @ApiResponse(successResponse(201, "Tao user thanh cong", userResponseSchema))
  @ApiResponse(errorResponse(400, "VALIDATION_ERROR: Du lieu khong hop le"))
  @ApiResponse(errorResponse(409, "EMAIL_EXISTS: Email da ton tai"))
  @RateLimit({ tier: "auth", capacity: 5, windowMs: 60_000 })
  @Public() // BAT BUOC - thieu dong nay se bi AccessTokenGuard chan 401
  @Post("register")
  @HttpCode(HttpStatus.CREATED)
  register(@Body() dto: RegisterDto) {
    // Controller CHI goi use case - khong query DB, khong kiem tra logic,
    // khong tu ky JWT o day.
    return this.registerUserUseCase.execute(dto);
  }

  @ApiOperation({ summary: "Dang nhap, nhan JWT access token" })
  @ApiResponse(successResponse(200, "Dang nhap thanh cong", loginResponseSchema))
  @ApiResponse(errorResponse(401, "INVALID_CREDENTIALS: Email hoac mat khau khong dung"))
  @RateLimit({ tier: "auth", capacity: 5, windowMs: 60_000 })
  @Public()
  @Post("login")
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto) {
    return this.loginUseCase.execute(dto);
  }

  @ApiOperation({ summary: "Doi refresh token lay cap access token + refresh token moi" })
  @RateLimit({ tier: "auth", capacity: 10, windowMs: 60_000 })
  @Public()
  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshTokenDto) {
    return this.loginUseCase.refresh(dto.refreshToken);
  }

  @ApiOperation({ summary: "Dang xuat: thu hoi ngay JWT (jti) va refresh token" })
  @ApiBearerAuth("access-token")
  @Post("logout")
  @HttpCode(HttpStatus.OK)
  logout(@CurrentUser() user: AccessTokenPayload, @Body() dto?: LogoutDto) {
    return this.loginUseCase.logout(user, dto?.refreshToken);
  }
}
