import { IsString, IsNotEmpty, IsUUID, IsNumberString, IsOptional, Matches, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TransferMoneyDto {
  @ApiProperty({ format: 'uuid', example: '81ed4895-3bc6-46c9-b7b2-c0e86b978a10', description: 'Source account UUID' })
  @IsUUID()
  @IsNotEmpty()
  sourceAccountId!: string;

  @ApiProperty({ pattern: '^[0-9]{10,20}$', example: '100000012345', description: 'Destination bank account number' })
   @IsString()
   @IsNotEmpty()
   @Matches(/^[0-9]{10,20}$/, {
     message: 'destinationAccountNumber must contain 10 to 20 digits',
   })
   destinationAccountNumber!: string;

  @ApiProperty({ type: String, pattern: '^[1-9]\\d*$', example: '100000', description: 'Transfer amount (positive numeric integer string)' })
  @IsNumberString()
  @Matches(/^[1-9]\d*$/, { message: 'Amount must be greater than 0 and cannot start with zero' })
  @IsNotEmpty()
  @MaxLength(18, { message: 'Amount must not exceed 18 digits' })
  amount!: string;

  @ApiPropertyOptional({ example: 'Lunch payment', description: 'Transfer description (Optional)' })
  @IsOptional()
  @IsString()
  @MaxLength(250)
  description?: string;
}
