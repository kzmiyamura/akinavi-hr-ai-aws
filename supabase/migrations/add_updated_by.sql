-- Migration: candidatesテーブルにupdated_byカラムを追加
-- Supabase SQL Editorで実行してください

ALTER TABLE candidates ADD COLUMN IF NOT EXISTS updated_by text;
