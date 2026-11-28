import { successResponse, errorResponse } from '@src/common/http/swagger/response.schemas';
import { transactionResponseSchema } from './dto/money-movement-response.schema';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags, ApiParam } from '@nestjs/swagger';
import { Paginated } from '../../../../common/http/interceptors/response-envelope.interceptor';
import { CurrentUser, RateLimit } from '../../../../common/security/decorators';
import { AccessTokenPayload } from '../../../../common/security/ports';
import { CreateTransactionDto, TransactionTypeDto } from './dto/create-transaction.dto';
import { ListTransactionsQueryDto } from './dto/list-transactions-query.dto';
import { DepositMoneyUseCase } from '../../application/use-cases/deposit-money.use-case';
import { WithdrawMoneyUseCase } from '../../application/use-cases/withdraw-money.use-case';
import { GetTransactionHistoryUseCase } from '../../application/use-cases/get-transaction-history.use-case';

@ApiTags('Money Movement')
@ApiBearerAuth('access-token')
@ApiResponse(errorResponse(400, 'VALIDATION_ERROR: dữ liệu đầu vào không hợp lệ.'))
@ApiResponse(errorResponse(500, 'INTERNAL_ERROR: lỗi nội bộ hệ thống.'))
@ApiResponse(errorResponse(401, 'UNAUTHORIZED: thiếu hoặc không chấp nhận access token.'))
@Controller('accounts')
export class TransactionController {
  constructor(
    private readonly depositMoneyUseCase: DepositMoneyUseCase,
    private readonly withdrawMoneyUseCase: WithdrawMoneyUseCase,
    private readonly getTransactionHistoryUseCase: GetTransactionHistoryUseCase,
  ) {}

  @ApiOperation({ summary: 'Create a deposit or withdrawal transaction (UC-05, UC-06)' })
  @ApiHeader({
    name: 'Idempotency-Key',
    description: 'Khóa không rỗng do client tạo (16–128 ký tự) để chống nạp/rút trùng khi retry mạng.',
    required: true,
    schema: { type: 'string', minLength: 16, maxLength: 128, example: 'tx-20261121-000001' },
  })
  @ApiResponse(successResponse(201, 'Transaction executed successfully', transactionResponseSchema))
  @ApiResponse(successResponse(200, 'Replay of existing transaction with identical Idempotency-Key', transactionResponseSchema))
  @ApiResponse(errorResponse(400, 'VALIDATION_ERROR hoặc thiếu/sai định dạng Idempotency-Key'))
  @ApiResponse(errorResponse(404, 'ACCOUNT_NOT_FOUND: Account not found or not owned by user'))
  @ApiResponse(errorResponse(409, 'INSUFFICIENT_FUNDS, ACCOUNT_NOT_ACTIVE hoặc IDEMPOTENCY_KEY_REUSED'))
  @ApiParam({ name: 'accountId', description: 'UUID of the bank account', format: 'uuid' })
  @RateLimit({ tier: 'transactions', capacity: 30, windowMs: 10_000 })
  @Post(':accountId/transactions')
  async createTransaction(
    @Param('accountId', new ParseUUIDPipe({ version: '4' })) accountId: string,
    @Body() dto: CreateTransactionDto,
    @CurrentUser() user: AccessTokenPayload,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const trimmedKey = idempotencyKey?.trim();
    if (!trimmedKey || trimmedKey.length < 16 || trimmedKey.length > 128) {
      throw new BadRequestException('Idempotency-Key header must be between 16 and 128 characters');
    }

    const result =
      dto.type === TransactionTypeDto.CREDIT
        ? await this.depositMoneyUseCase.execute({
            accountId,
            userId: user.sub,
            amount: dto.amount,
            idempotencyKey: trimmedKey,
            description: dto.description,
          })
        : await this.withdrawMoneyUseCase.execute({
            accountId,
            userId: user.sub,
            amount: dto.amount,
            idempotencyKey: trimmedKey,
            description: dto.description,
          });

    res.status(result.isReplay ? HttpStatus.OK : HttpStatus.CREATED);
    return result.transaction;
  }

  @ApiOperation({ summary: 'Get paginated transaction history with filters (UC-06)' })
  @ApiParam({ name: 'accountId', description: 'UUID of the bank account', format: 'uuid' })
  @ApiResponse(successResponse(200, 'Paginated list of transactions', transactionResponseSchema, true))
  @ApiResponse(errorResponse(404, 'ACCOUNT_NOT_FOUND: Account not found or not owned by authenticated user'))
  @Get(':accountId/transactions')
  async getTransactions(
    @Param('accountId', new ParseUUIDPipe({ version: '4' })) accountId: string,
    @Query() query: ListTransactionsQueryDto,
    @CurrentUser() user: AccessTokenPayload,
  ) {
    const result = await this.getTransactionHistoryUseCase.execute({
      accountId,
      userId: user.sub,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      type: query.type,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });

    return new Paginated(
      result.items,
      result.page,
      result.limit,
      result.total,
    );
  }
}
