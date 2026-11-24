import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  errorResponse,
  successResponse,
} from '@src/common/http/swagger/response.schemas';
import { Public } from '@src/common/security/decorators';
import {
  type HealthCheckReport,
  HealthService,
} from '../../application/health.service';
import { healthResponseSchema } from './dto/health-response.schema';

@ApiTags('Health')
@ApiResponse(errorResponse(400, 'VALIDATION_ERROR: dữ liệu đầu vào không hợp lệ.'))
@ApiResponse(errorResponse(500, 'INTERNAL_ERROR: lỗi nội bộ hệ thống.'))
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @ApiOperation({
    summary:
      'Kiểm tra sức khỏe toàn diện (Postgres, Redis, Piscina Worker Pool & Outbox lag)',
  })
  @ApiResponse(
    successResponse(
      200,
      'Hệ thống hoạt động bình thường (OK) hoặc suy giảm mềm (DEGRADED)',
      healthResponseSchema,
    ),
  )
  @ApiResponse(
    errorResponse(
      503,
      'SERVICE_UNAVAILABLE: Thành phần sống còn (Postgres / Piscina) không sẵn sàng',
    ),
  )
  @Public()
  @Get()
  @HttpCode(HttpStatus.OK)
  check(): Promise<HealthCheckReport> {
    return this.healthService.check();
  }
}
