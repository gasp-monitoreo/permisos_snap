from django.contrib import admin
from .models import DriveFolderMap


@admin.register(DriveFolderMap)
class DriveFolderMapAdmin(admin.ModelAdmin):
    list_display  = ('folder_name', 'tramite_ids', 'notas')
    search_fields = ('folder_name', 'notas')
    ordering      = ('folder_name',)
