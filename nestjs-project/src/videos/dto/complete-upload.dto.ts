import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class CompleteUploadPartDto {
  @IsInt()
  @Min(1)
  part_number: number;

  @IsString()
  @IsNotEmpty()
  e_tag: string;
}

export class CompleteUploadDto {
  @IsString()
  @IsNotEmpty()
  upload_id: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CompleteUploadPartDto)
  parts?: CompleteUploadPartDto[];
}
