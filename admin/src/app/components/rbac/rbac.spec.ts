import { ComponentFixture, TestBed } from '@angular/core/testing';

import { RBAC } from './rbac';

describe('RBAC', () => {
  let component: RBAC;
  let fixture: ComponentFixture<RBAC>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RBAC],
    }).compileComponents();

    fixture = TestBed.createComponent(RBAC);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
