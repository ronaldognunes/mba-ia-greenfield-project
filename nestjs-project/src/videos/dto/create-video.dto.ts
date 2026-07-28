import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

export class CreateVideoDto {
  @IsString()
  @IsNotEmpty()
  original_filename: string;

  @IsString()
  @IsNotEmpty()
  content_type: string;

  @IsInt()
  @Min(1)
  file_size_bytes: number;
}
