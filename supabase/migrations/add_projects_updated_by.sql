-- Migration: projectsテーブルにupdated_byカラムを追加
-- Supabase SQL Editorで実行してください

ALTER TABLE projects ADD COLUMN IF NOT EXISTS updated_by text;

