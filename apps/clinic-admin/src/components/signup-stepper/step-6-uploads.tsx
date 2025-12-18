
'use client';

import { useFormContext } from 'react-hook-form';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Upload, Edit, Trash2 } from 'lucide-react';
import type { SignUpFormData } from '@/app/(public)/signup/page';
import Image from 'next/image';
import { useState, useRef, useEffect } from 'react';
import { FormControl, FormField, FormItem, FormMessage } from '../ui/form';
import { Input } from '@/components/ui/input';

const FileUpload = ({
  field,
  label,
  isRequired,
}: {
  field: any;
  label: string;
  isRequired: boolean;
}) => {
  const [preview, setPreview] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (field.value instanceof File && field.value.type.startsWith('image/')) {
      const objectUrl = URL.createObjectURL(field.value);
      setPreview(objectUrl);
      return () => URL.revokeObjectURL(objectUrl);
    } else {
      setPreview(null);
    }
  }, [field.value]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    field.onChange(file);
  };

  const handleEdit = () => {
    inputRef.current?.click();
  };

  const handleDelete = () => {
    field.onChange(null);
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  };

  return (
    <FormItem>
      <Label>
        {label}
        {isRequired && <span className="text-destructive">*</span>}
      </Label>
      <div className="flex items-center gap-4">
        <div className="w-20 h-20 rounded-md bg-muted flex items-center justify-center overflow-hidden">
          {preview ? (
            <Image
              src={preview}
              alt="preview"
              width={80}
              height={80}
              className="object-cover"
            />
          ) : (
            <Upload className="h-6 w-6 text-muted-foreground" />
          )}
        </div>
        <div className="flex-grow">
          <FormControl>
            <Input
              type="file"
              accept="image/*,.pdf"
              onChange={handleFileChange}
              ref={inputRef}
              style={{ display: 'none' }}
              id={`file-input-${field.name}`}
            />
          </FormControl>
          {field.value ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground truncate max-w-xs">
                {field.value.name}
              </span>
              <Button type="button" size="icon" variant="ghost" onClick={handleEdit}>
                <Edit className="h-4 w-4" />
              </Button>
              <Button type="button" size="icon" variant="ghost" onClick={handleDelete}>
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              onClick={() => inputRef.current?.click()}
            >
              <Upload className="mr-2 h-4 w-4" />
              Choose File
            </Button>
          )}
        </div>
      </div>
      <FormMessage />
    </FormItem>
  );
};

export function Step6Uploads() {
  const { control } = useFormContext<SignUpFormData>();

  return (
    <div>
      <p className="text-sm text-muted-foreground">Step 6/7</p>
      <h2 className="text-2xl font-bold mb-1">Uploads</h2>
      <p className="text-muted-foreground mb-6">
        Adding these will build trust and complete your profile.
      </p>

      <div className="space-y-6">
        <FormField
          control={control}
          name="logo"
          render={({ field }) => (
            <FileUpload field={field} label="Clinic Logo" isRequired={false} />
          )}
        />
        <FormField
          control={control}
          name="license"
          render={({ field }) => (
            <FileUpload
              field={field}
              label="Doctor/Clinic License Copy"
              isRequired={true}
            />
          )}
        />
        <FormField
          control={control}
          name="receptionPhoto"
          render={({ field }) => (
            <FileUpload
              field={field}
              label="Reception / Waiting Area Photo (only for verification purpose)"
              isRequired={false}
            />
          )}
        />
      </div>
    </div>
  );
}
